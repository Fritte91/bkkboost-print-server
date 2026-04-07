import { readFileSync } from 'node:fs';
import express from 'express';
import { authMiddleware } from './auth.js';
import { enqueue, listJobs, getJob, retryJob, cancelJob, jobExists, getJobCounts } from './queue.js';
import { getPrinterStatuses } from './printer.js';
import { startScheduler } from './scheduler.js';
import logger from './logger.js';

const config = JSON.parse(readFileSync('config.json', 'utf-8'));

const printerMap = new Map(config.printers.map((p) => [p.printer_id, p]));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware(config));

// POST /print
app.post('/print', (req, res) => {
  const { id, printer_id, escpos_bytes, round_id, restaurant_id } = req.body;

  if (!id || !printer_id || !escpos_bytes) {
    return res.status(400).json({ error: 'Missing required fields: id, printer_id, escpos_bytes' });
  }

  const printer = printerMap.get(printer_id);
  if (!printer) {
    return res.status(400).json({ error: `Unknown printer_id: ${printer_id}` });
  }

  if (jobExists(id)) {
    return res.status(409).json({ error: 'Job already exists', jobId: id });
  }

  enqueue({
    id,
    printer_id,
    usb_path: printer.usb_path,
    escpos_bytes,
    round_id,
    restaurant_id,
  });

  logger.info(`Job ${id} queued for printer ${printer.name} (${printer.usb_path})`);
  res.status(202).json({ jobId: id, status: 'queued' });
});

// GET /jobs
app.get('/jobs', (req, res) => {
  const { status, printer_id } = req.query;
  const jobs = listJobs({ status, printer_id });
  res.json(jobs);
});

// GET /jobs/:id
app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// POST /jobs/:id/retry
app.post('/jobs/:id/retry', (req, res) => {
  const result = retryJob(req.params.id);
  if (!result) return res.status(404).json({ error: 'Job not found' });
  logger.info(`Job ${req.params.id} retried`);
  res.json(result);
});

// DELETE /jobs/:id
app.delete('/jobs/:id', (req, res) => {
  const result = cancelJob(req.params.id);
  if (!result.found) return res.status(404).json({ error: 'Job not found' });
  if (!result.cancellable) return res.status(400).json({ error: 'Job is not cancellable (not in queued state)' });
  logger.info(`Job ${req.params.id} cancelled`);
  res.json({ cancelled: true });
});

// GET /printers
app.get('/printers', async (req, res) => {
  const statuses = await getPrinterStatuses(config.printers);
  res.json(statuses);
});

// GET /health
app.get('/health', (req, res) => {
  const counts = getJobCounts();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    jobs: {
      queued: counts.queued,
      printing: counts.printing,
      failed: counts.failed,
      dead: counts.dead,
    },
  });
});

const PORT = config.port || 3000;
app.listen(PORT, () => {
  logger.info(`Print server listening on port ${PORT}`);
  startScheduler(config);
});
