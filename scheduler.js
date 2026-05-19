import { claimNextJob, markDone, markFailed, resetInterruptedJobs, resetStalePrintingJobs, listDeadJobsForPrinter, retryJob, getStaleQueuedForPrinter } from './queue.js';
import { writeToPrinter, isPrinterConnected, getPrinterStatuses } from './printer.js';
import logger from './logger.js';

const STALE_OFFLINE_MS = 60_000;
const STALE_PRINTING_MS = 120_000;
const CALLBACK_RETRY_DELAY_MS = 3000;
const SHUTDOWN_WAIT_MS = 5000;
// Cap cold-start dead-job retry to recent jobs so a Wyse reboot the next
// morning doesn't reprint yesterday's already-resolved failures.
const COLD_START_DEAD_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const lastConnected = new Map(); // printer_id → boolean
let _config = null;
const printerIntervals = []; // track per-printer intervals so we can replace them
let _healthInterval = null;
let _sweeperInterval = null;

export function startScheduler(config) {
  _config = config;
  const reset = resetInterruptedJobs();
  if (reset.changes > 0) {
    logger.info(`Reset ${reset.changes} interrupted printing jobs back to queued`);
  }

  for (const printer of config.printers) {
    printerIntervals.push(setInterval(() => processPrinter(printer), 1000));
  }

  _healthInterval = setInterval(() => healthCheck(_config), 10_000);
  _sweeperInterval = setInterval(sweepStalledPrintingJobs, 60_000);

  logger.info(`Scheduler started for ${config.printers.length} printer(s)`);
}

export function updatePrinters(printers) {
  // Clear existing printer intervals
  for (const id of printerIntervals) {
    clearInterval(id);
  }
  printerIntervals.length = 0;

  // Drop lastConnected entries for printers no longer in the list so cold-start
  // retry fires correctly if the same printer_id is ever re-added later.
  const newIds = new Set(printers.map((p) => p.printer_id));
  for (const id of lastConnected.keys()) {
    if (!newIds.has(id)) lastConnected.delete(id);
  }

  // Update config reference
  _config.printers = printers;

  // Start new intervals
  for (const printer of printers) {
    printerIntervals.push(setInterval(() => processPrinter(printer), 1000));
  }

  logger.info(`Printer list updated: ${printers.length} printer(s) — ${printers.map((p) => p.name).join(', ')}`);
}

export async function stopScheduler(timeoutMs = SHUTDOWN_WAIT_MS) {
  for (const id of printerIntervals) {
    clearInterval(id);
  }
  printerIntervals.length = 0;

  if (_healthInterval) {
    clearInterval(_healthInterval);
    _healthInterval = null;
  }
  if (_sweeperInterval) {
    clearInterval(_sweeperInterval);
    _sweeperInterval = null;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inFlight = (_config?.printers ?? []).some((p) => p.processing);
    if (!inFlight) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  logger.warn('Shutdown: some processPrinter calls still in-flight after timeout');
}

async function processPrinter(printer) {
  // C1 belt-and-suspenders: the atomic claim in claimNextJob prevents double-
  // claiming at the SQL layer. This in-process flag additionally skips ticks
  // that overlap with a slow WiFi write, cutting pointless DB round-trips.
  if (printer.processing) return;
  printer.processing = true;

  let jobId = null;
  try {
    const connected = await isPrinterConnected(printer);
    if (!connected) {
      // Give the printer up to STALE_OFFLINE_MS to come back (USB flap, brief
      // power cycle, WiFi dropout). Anything older has waited long enough —
      // fail it so the caller learns instead of the receipt being silently lost.
      const staleJobs = getStaleQueuedForPrinter(printer.printer_id, STALE_OFFLINE_MS);
      for (const job of staleJobs) {
        const result = markFailed(job.id, 'printer_offline');
        logger.warn(`Job ${job.id} marked ${result?.isDead ? 'dead' : 'failed'} — printer ${printer.name} offline`);

        // Fire callback on first failure (attempts === 1) so the staff app
        // learns immediately the physical print didn't happen. Also fire on
        // terminal dead. Skip intermediate attempts (2..max-1) — same job,
        // staff already knows.
        const shouldCallback = result?.isDead || result?.attempts === 1;

        if (shouldCallback) {
          fireStatusCallback(_config, {
            round_id: result.round_id,
            printer_id: result.printer_id,
            restaurant_id: result.restaurant_id,
            session_id: result.session_id ?? null,
            job_type: result.job_type ?? null,
            success: false,
            error: result.isDead
              ? 'Printer offline, permanently failed after max attempts'
              : 'Printer offline — print did not occur',
          });
        }
      }
      return;
    }

    // Atomic: fetch + mark 'printing' in one SQL statement. Returns null if
    // nothing ready.
    const job = claimNextJob(printer.printer_id);
    if (!job) return;

    jobId = job.id;
    logger.info(`Printing job ${job.id} on ${printer.name}`);

    const start = Date.now();
    await writeToPrinter(printer, job.escpos_bytes);
    const duration = Date.now() - start;

    markDone(job.id);
    logger.info(`Job ${job.id} printed on ${printer.name} in ${duration}ms`);
    fireStatusCallback(_config, {
      round_id: job.round_id,
      printer_id: job.printer_id,
      restaurant_id: job.restaurant_id,
      session_id: job.session_id ?? null,
      job_type: job.job_type ?? null,
      success: true,
      error: null,
    });
  } catch (err) {
    logger.error(`Printer ${printer.name} error: ${err.message}`);
    if (jobId) {
      const result = markFailed(jobId, err.message);
      logger.warn(`Job ${jobId} marked ${result?.isDead ? 'dead' : 'failed'}`);
      if (result?.isDead) {
        fireStatusCallback(_config, {
          round_id: result.round_id,
          printer_id: result.printer_id,
          restaurant_id: result.restaurant_id,
          session_id: result.session_id ?? null,
          job_type: result.job_type ?? null,
          success: false,
          error: `Print job permanently failed after ${result.attempts} attempts`,
        });
      }
    }
  } finally {
    printer.processing = false;
  }
}

function sweepStalledPrintingJobs() {
  try {
    const result = resetStalePrintingJobs(STALE_PRINTING_MS);
    if (result.changes > 0) {
      logger.warn(`Sweeper: reset ${result.changes} stalled 'printing' job(s) (>${STALE_PRINTING_MS}ms) back to queued`);
    }
  } catch (err) {
    logger.error(`Sweeper error: ${err.message}`);
  }
}

async function healthCheck(config) {
  try {
    const statuses = await getPrinterStatuses(config.printers);

    // Detect changes
    let changed = false;
    for (const s of statuses) {
      const prev = lastConnected.get(s.printer_id);

      // Cold-start retry: on the first tick after process boot, if a printer
      // is connected and has dead jobs from a prior run, retry them. Without
      // this, a Wyse reboot orphans yesterday's dead jobs until a live
      // disconnect/reconnect cycle happens.
      if (prev === undefined && s.connected) {
        const deadJobs = listDeadJobsForPrinter(s.printer_id, COLD_START_DEAD_MAX_AGE_MS);
        if (deadJobs.length > 0) {
          for (const job of deadJobs) {
            retryJob(job.id);
          }
          logger.info(`[printer ${s.name}] Cold-start retry: ${deadJobs.length} dead job(s) from prior run`);
        }
      }

      if (prev !== s.connected) {
        changed = true;

        // Reconnected — retry dead jobs for this printer
        if (prev === false && s.connected) {
          const deadJobs = listDeadJobsForPrinter(s.printer_id);
          if (deadJobs.length > 0) {
            for (const job of deadJobs) {
              retryJob(job.id);
            }
            logger.info(`Printer ${s.name} reconnected — retrying ${deadJobs.length} dead job(s)`);
          }
        }

        lastConnected.set(s.printer_id, s.connected);
      }
    }

    if (!changed) return;

    logger.info(`Printer status change: ${statuses.map((s) => `${s.name}=${s.connected ? 'connected' : 'disconnected'}`).join(', ')}`);

    if (!config.health_callback_url) return;

    await fetch(config.health_callback_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        restaurant_id: config.restaurant_id,
        printers: statuses.map((s) => ({
          printer_id: s.printer_id,
          connected: s.connected,
        })),
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    logger.error(`Health callback failed: ${err.message}`);
  }
}

// Two attempts, 3s apart. The staff app will also catch up via polling, so
// we don't need an unbounded retry queue here.
async function fireStatusCallback(config, payload) {
  if (!config.status_callback_url) return;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fetch(config.status_callback_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.auth_token}`,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      logger.info(`Status callback sent for round ${payload.round_id}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
      return;
    } catch (err) {
      if (attempt === 1) {
        logger.warn(`Status callback attempt 1 failed: ${err.message} — retrying in ${CALLBACK_RETRY_DELAY_MS}ms`);
        await new Promise((r) => setTimeout(r, CALLBACK_RETRY_DELAY_MS));
      } else {
        logger.error(`Status callback failed after 2 attempts: ${err.message}`);
      }
    }
  }
}
