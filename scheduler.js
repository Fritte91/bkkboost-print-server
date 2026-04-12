import { getNextReady, markPrinting, markDone, markFailed, resetInterruptedJobs, listDeadJobsForPrinter, retryJob } from './queue.js';
import { writeToPrinter, isPrinterConnected, getPrinterStatuses } from './printer.js';
import logger from './logger.js';

const lastConnected = new Map(); // usb_path → boolean
let _config = null;
const printerIntervals = []; // track per-printer intervals so we can replace them

export function startScheduler(config) {
  _config = config;
  const reset = resetInterruptedJobs();
  if (reset.changes > 0) {
    logger.info(`Reset ${reset.changes} interrupted printing jobs back to queued`);
  }

  for (const printer of config.printers) {
    printerIntervals.push(setInterval(() => processPrinter(printer), 1000));
  }

  setInterval(() => healthCheck(_config), 10_000);

  logger.info(`Scheduler started for ${config.printers.length} printer(s)`);
}

export function updatePrinters(printers) {
  // Clear existing printer intervals
  for (const id of printerIntervals) {
    clearInterval(id);
  }
  printerIntervals.length = 0;

  // Update config reference
  _config.printers = printers;

  // Start new intervals
  for (const printer of printers) {
    printerIntervals.push(setInterval(() => processPrinter(printer), 1000));
  }

  logger.info(`Printer list updated: ${printers.length} printer(s) — ${printers.map((p) => p.name).join(', ')}`);
}

async function processPrinter(printer) {
  let jobId = null;
  try {
    const connected = await isPrinterConnected(printer.usb_path);
    if (!connected) return;

    const job = getNextReady(printer.usb_path);
    if (!job) return;

    jobId = job.id;
    markPrinting(job.id);
    logger.info(`Printing job ${job.id} on ${printer.usb_path}`);

    await writeToPrinter(printer.usb_path, job.escpos_bytes);

    markDone(job.id);
    logger.info(`Job ${job.id} done`);
    fireStatusCallback(_config, {
      round_id: job.round_id,
      printer_id: job.printer_id,
      restaurant_id: job.restaurant_id,
      success: true,
      error: null,
    });
  } catch (err) {
    logger.error(`Printer ${printer.usb_path} error: ${err.message}`);
    if (jobId) {
      const result = markFailed(jobId, err.message);
      logger.warn(`Job ${jobId} marked ${result?.isDead ? 'dead' : 'failed'}`);
      if (result?.isDead) {
        fireStatusCallback(_config, {
          round_id: result.round_id,
          printer_id: result.printer_id,
          restaurant_id: result.restaurant_id,
          success: false,
          error: `Print job permanently failed after ${result.attempts} attempts`,
        });
      }
    }
  }
}

async function healthCheck(config) {
  try {
    const statuses = await getPrinterStatuses(config.printers);

    // Detect changes
    let changed = false;
    for (const s of statuses) {
      const prev = lastConnected.get(s.usb_path);
      if (prev !== s.connected) {
        changed = true;

        // Reconnected — retry dead jobs for this printer
        if (prev === false && s.connected) {
          const deadJobs = listDeadJobsForPrinter(s.usb_path);
          if (deadJobs.length > 0) {
            for (const job of deadJobs) {
              retryJob(job.id);
            }
            logger.info(`Printer ${s.name} reconnected — retrying ${deadJobs.length} dead job(s)`);
          }
        }

        lastConnected.set(s.usb_path, s.connected);
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
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.error(`Health callback failed: ${err.message}`);
  }
}

async function fireStatusCallback(config, payload) {
  if (!config.status_callback_url) return;
  try {
    await fetch(config.status_callback_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.auth_token}`,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    logger.info(`Status callback sent for round ${payload.round_id}`);
  } catch (err) {
    logger.error(`Status callback failed: ${err.message}`);
  }
}
