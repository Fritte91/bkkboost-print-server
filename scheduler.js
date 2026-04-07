import { getNextReady, markPrinting, markDone, markFailed, resetInterruptedJobs } from './queue.js';
import { writeToPrinter, isPrinterConnected, getPrinterStatuses } from './printer.js';
import logger from './logger.js';

let lastStatuses = null;

export function startScheduler(config) {
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
  } catch (err) {
    logger.error(`Printer ${printer.usb_path} error: ${err.message}`);
    if (jobId) {
      markFailed(jobId, err.message);
      logger.warn(`Job ${jobId} marked failed`);
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
