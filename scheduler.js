import { getNextReady, markPrinting, markDone, markFailed, resetInterruptedJobs } from './queue.js';
import { writeToPrinter, isPrinterConnected, getPrinterStatuses } from './printer.js';
import logger from './logger.js';

let lastStatuses = null;
let _config = null;

export function startScheduler(config) {
  _config = config;
  const reset = resetInterruptedJobs();
  if (reset.changes > 0) {
    logger.info(`Reset ${reset.changes} interrupted printing jobs back to queued`);
  }

  for (const printer of config.printers) {
    setInterval(() => processPrinter(printer), 1000);
  }

  setInterval(() => healthCheck(config), 10_000);

  logger.info(`Scheduler started for ${config.printers.length} printer(s)`);
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

    const statusKey = JSON.stringify(statuses.map((s) => s.connected));
    if (lastStatuses === statusKey) return;
    lastStatuses = statusKey;

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
