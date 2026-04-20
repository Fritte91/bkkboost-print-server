import 'dotenv/config';
import { readFileSync } from 'node:fs';
import express from 'express';
import cors from 'cors';
import { authMiddleware } from './auth.js';
import { enqueue, listJobs, getJob, retryJob, cancelJob, jobExists, getJobCounts, listJobsForLogs } from './queue.js';
import { getPrinterStatuses } from './printer.js';
import { startScheduler, updatePrinters } from './scheduler.js';
import logger from './logger.js';

const config = JSON.parse(readFileSync('config.json', 'utf-8'));

config.supabase_url = process.env.SUPABASE_URL ?? '';
config.supabase_service_key = process.env.SUPABASE_SERVICE_KEY ?? '';

if (!config.supabase_url || !config.supabase_service_key) {
  console.warn('[config] SUPABASE_URL and/or SUPABASE_SERVICE_KEY not set. Live printer sync disabled; using static printers from config.json.');
}

let printerMap = new Map(config.printers.map((p) => [p.printer_id, p]));

async function fetchPrintersFromSupabase() {
  if (!config.supabase_url || !config.supabase_service_key) return null;

  const url = `${config.supabase_url}/rest/v1/restaurant_printers?restaurant_id=eq.${config.restaurant_id}&is_active=eq.true&select=id,name,usb_path`;
  const res = await fetch(url, {
    headers: {
      'apikey': config.supabase_service_key,
      'Authorization': `Bearer ${config.supabase_service_key}`,
    },
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    throw new Error(`Supabase responded with ${res.status}`);
  }

  const rows = await res.json();
  return rows.map((r) => ({
    printer_id: r.id,
    name: r.name,
    usb_path: r.usb_path,
  }));
}

async function refreshPrinterConfig() {
  try {
    const printers = await fetchPrintersFromSupabase();
    if (!printers) return; // no Supabase configured

    config.printers = printers;
    printerMap = new Map(printers.map((p) => [p.printer_id, p]));
    updatePrinters(printers);
    logger.info(`Printer config refreshed from Supabase: ${printers.length} printer(s)`);
  } catch (err) {
    logger.warn(`Failed to fetch printers from Supabase, keeping current config: ${err.message}`);
  }
}

const app = express();
app.use(cors({
  origin: [
    'https://dine-staff.bkkboost.com',
    'https://dine-admin.bkkboost.com',
    'http://localhost:3000',
    'https://localhost',
  ],
}));
app.use(express.json({ limit: '1mb' }));
app.use(authMiddleware(config));

// POST /print
app.post('/print', (req, res) => {
  const { id, idempotency_key, printer_id, escpos_bytes, round_id, restaurant_id, session_id, job_type } = req.body;
  const jobId = id || idempotency_key;

  if (!jobId || !printer_id || !escpos_bytes) {
    return res.status(400).json({ error: 'Missing required fields: id (or idempotency_key), printer_id, escpos_bytes' });
  }

  if (job_type !== undefined && job_type !== 'kitchen' && job_type !== 'receipt') {
    return res.status(400).json({ error: `Invalid job_type: ${job_type}. Must be 'kitchen' or 'receipt' or omitted.` });
  }

  if (session_id !== undefined && session_id !== null && typeof session_id !== 'string') {
    return res.status(400).json({ error: 'session_id must be a string UUID or null' });
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
    session_id,
    job_type,
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
  const { status, printer_id, job_type, limit, offset, from, to } = req.query;

  if (job_type !== undefined && job_type !== 'kitchen' && job_type !== 'receipt') {
    return res.status(400).json({ error: `Invalid job_type: ${job_type}. Must be 'kitchen' or 'receipt' or omitted.` });
  }

  const result = listJobsForLogs({
    status,
    printer_id,
    job_type,
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
app.listen(PORT, async () => {
  logger.info(`Print server listening on port ${PORT}`);

  // Try to load printer config from Supabase before starting the scheduler
  try {
    const printers = await fetchPrintersFromSupabase();
    if (printers) {
      config.printers = printers;
      printerMap = new Map(printers.map((p) => [p.printer_id, p]));
      logger.info(`Loaded ${printers.length} printer(s) from Supabase`);
    }
  } catch (err) {
    logger.warn(`Supabase fetch failed on startup, using config.json printers: ${err.message}`);
  }

  startScheduler(config);

  // Refresh printer config from Supabase every 5 minutes
  setInterval(refreshPrinterConfig, 5 * 60 * 1000);
});
