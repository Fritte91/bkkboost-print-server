import { readFileSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './auth.js';
import { enqueue, listJobs, getJob, retryJob, cancelJob, jobExists, getJobCounts, listJobsForLogs } from './queue.js';
import { getPrinterStatuses } from './printer.js';
import { startScheduler } from './scheduler.js';
import logger from './logger.js';

const config = JSON.parse(readFileSync('config.json', 'utf-8'));

const printerMap = new Map(config.printers.map((p) => [p.printer_id, p]));

const app = express();
app.use(cors({
  origin: [
    'https://dine-staff.bkkboost.com',
    'https://dine-admin.bkkboost.com',
    'http://localhost:3000',
  ],
}));
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware(config));

// POST /print
app.post('/print', (req, res) => {
  const { id, idempotency_key, printer_id, escpos_bytes, round_id, restaurant_id } = req.body;
  const jobId = id || idempotency_key;

  if (!jobId || !printer_id || !escpos_bytes) {
    return res.status(400).json({ error: 'Missing required fields: id (or idempotency_key), printer_id, escpos_bytes' });
  }

  const printer = printerMap.get(printer_id);
  if (!printer) {
    return res.status(400).json({ error: `Unknown printer_id: ${printer_id}` });
  }

  if (jobExists(jobId)) {
    return res.status(409).json({ error: 'Job already exists', jobId });
  }

  enqueue({
    id: jobId,
    printer_id,
    usb_path: printer.usb_path,
    escpos_bytes,
    round_id,
    restaurant_id,
  });

  logger.info(`Job ${jobId} queued for printer ${printer.name} (${printer.usb_path})`);
  res.status(202).json({ jobId, status: 'queued' });
});

// POST /print-round
app.post('/print-round', async (req, res) => {
  const { round_id, restaurant_id } = req.body;

  if (!round_id) {
    return res.status(400).json({ error: 'Missing required field: round_id' });
  }

  if (!config.staff_app_url) {
    return res.status(500).json({ error: 'staff_app_url not configured on print server' });
  }

  // Fetch print jobs from the staff app
  let jobs;
  try {
    const staffRes = await fetch(`${config.staff_app_url}/api/print/job/internal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.auth_token}`,
      },
      body: JSON.stringify({ round_id, restaurant_id }),
      signal: AbortSignal.timeout(10000),
    });

    if (!staffRes.ok) {
      const err = await staffRes.json().catch(() => ({}));
      logger.error(`Staff app returned ${staffRes.status} for round ${round_id}: ${err.error || 'Unknown error'}`);
      return res.status(502).json({ error: `Staff app error: ${err.error || staffRes.status}` });
    }

    const data = await staffRes.json();
    jobs = data.jobs;
  } catch (err) {
    logger.error(`Failed to reach staff app for round ${round_id}: ${err.message}`);
    return res.status(502).json({ error: `Staff app unreachable: ${err.message}` });
  }

  if (!Array.isArray(jobs) || jobs.length === 0) {
    logger.info(`No print jobs returned for round ${round_id}`);
    return res.status(202).json({ queued: 0 });
  }

  // Enqueue each job
  let queued = 0;
  for (const job of jobs) {
    const printer = printerMap.get(job.printerId);
    if (!printer) {
      logger.warn(`Round ${round_id}: printer_id ${job.printerId} not in config, skipping`);
      continue;
    }

    const jobId = job.jobId || crypto.randomUUID();

    if (jobExists(jobId)) {
      logger.info(`Round ${round_id}: job ${jobId} already exists, skipping`);
      continue;
    }

    enqueue({
      id: jobId,
      printer_id: job.printerId,
      usb_path: printer.usb_path,
      escpos_bytes: job.escposBytes,
      round_id,
      restaurant_id,
    });
    queued++;
  }

  logger.info(`Round ${round_id}: ${queued} job(s) queued`);
  res.status(202).json({ queued });
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
  if (!result.cancellable) return res.status(400).json({ error: 'Job is not cancellable (must be queued or dead)' });
  logger.info(`Job ${req.params.id} cancelled`);
  res.json({ cancelled: true });
});

// GET /printers
app.get('/printers', async (req, res) => {
  const statuses = await getPrinterStatuses(config.printers);
  res.json(statuses);
});

// GET /logs
app.get('/logs', (req, res) => {
  const { status, printer_id, limit, offset, from, to } = req.query;
  const result = listJobsForLogs({
    status,
    printer_id,
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
    from: from ? parseInt(from, 10) : undefined,
    to: to ? parseInt(to, 10) : undefined,
  });
  res.json(result);
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
