import db from './db.js';

const RETRY_DELAYS = [5_000, 30_000, 120_000, 600_000]; // ms

const stmts = {
  enqueue: db.prepare(`
    INSERT OR IGNORE INTO print_jobs
      (id, printer_id, usb_path, escpos_bytes, status, attempts, max_attempts,
       round_id, restaurant_id, session_id, job_type, created_at, updated_at)
    VALUES
      (@id, @printer_id, @usb_path, @escpos_bytes, 'queued', 0, @max_attempts,
       @round_id, @restaurant_id, @session_id, @job_type, @created_at, @updated_at)
  `),

  getNextReady: db.prepare(`
    SELECT * FROM print_jobs
    WHERE usb_path = ? AND status IN ('queued', 'failed')
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT 1
  `),

  markPrinting: db.prepare(`
    UPDATE print_jobs SET status = 'printing', updated_at = ? WHERE id = ?
  `),

  markDone: db.prepare(`
    UPDATE print_jobs SET status = 'done', error = NULL, updated_at = ? WHERE id = ?
  `),

  getJob: db.prepare(`SELECT * FROM print_jobs WHERE id = ?`),

  retryJob: db.prepare(`
    UPDATE print_jobs SET status = 'queued', next_retry_at = NULL, updated_at = ?
    WHERE id = ?
  `),

  cancelJob: db.prepare(`
    UPDATE print_jobs SET status = 'dead', updated_at = ?
    WHERE id = ? AND status IN ('queued', 'dead')
  `),

  markFailed: db.prepare(`
    UPDATE print_jobs
    SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'dead' ELSE 'failed' END,
        attempts = attempts + 1,
        error = @error,
        next_retry_at = @next_retry_at,
        updated_at = @updated_at
    WHERE id = @id
  `),

  resetPrinting: db.prepare(`
    UPDATE print_jobs SET status = 'queued', updated_at = ? WHERE status = 'printing'
  `),

  countByStatus: db.prepare(`
    SELECT status, COUNT(*) as count FROM print_jobs GROUP BY status
  `),

  deadJobsForPrinter: db.prepare(`
    SELECT id FROM print_jobs WHERE usb_path = ? AND status = 'dead'
  `),
};

export function enqueue(job) {
  const now = Date.now();
  return stmts.enqueue.run({
    id: job.id,
    printer_id: job.printer_id,
    usb_path: job.usb_path,
    escpos_bytes: Buffer.from(job.escpos_bytes),
    max_attempts: job.max_attempts || 5,
    round_id: job.round_id || null,
    restaurant_id: job.restaurant_id || null,
    session_id: job.session_id ?? null,
    job_type: job.job_type ?? null,
    created_at: now,
    updated_at: now,
  });
}

export function getNextReady(usbPath) {
  return stmts.getNextReady.get(usbPath, Date.now());
}

export function markPrinting(id) {
  return stmts.markPrinting.run(Date.now(), id);
}

export function markDone(id) {
  return stmts.markDone.run(Date.now(), id);
}

export function markFailed(id, error) {
  const job = stmts.getJob.get(id);
  if (!job) return null;

  const attempt = job.attempts;
  const isDead = job.attempts + 1 >= job.max_attempts;
  const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
  const nextRetry = isDead ? null : Date.now() + delay;

  stmts.markFailed.run({
    id,
    error: String(error),
    next_retry_at: nextRetry,
    updated_at: Date.now(),
  });

  return {
    isDead,
    attempts: job.attempts + 1,
    round_id: job.round_id,
    printer_id: job.printer_id,
    restaurant_id: job.restaurant_id,
    session_id: job.session_id ?? null,
    job_type: job.job_type ?? null,
  };
}

export function listJobs(filters = {}) {
  let sql = 'SELECT id, printer_id, usb_path, status, attempts, max_attempts, error, round_id, restaurant_id, session_id, job_type, created_at, updated_at, next_retry_at FROM print_jobs WHERE 1=1';
  const params = [];

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    sql += ` AND status IN (${statuses.map(() => '?').join(',')})`;
    params.push(...statuses);
  }
  if (filters.printer_id) {
    sql += ' AND printer_id = ?';
    params.push(filters.printer_id);
  }

  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params);
}

export function getJob(id) {
  const job = stmts.getJob.get(id);
  if (!job) return null;
  const { escpos_bytes, ...rest } = job;
  return rest;
}

export function retryJob(id) {
  const job = stmts.getJob.get(id);
  if (!job) return null;
  stmts.retryJob.run(Date.now(), id);
  return { status: 'queued' };
}

export function cancelJob(id) {
  const job = stmts.getJob.get(id);
  if (!job) return { found: false };
  if (job.status !== 'queued' && job.status !== 'dead') return { found: true, cancellable: false };
  stmts.cancelJob.run(Date.now(), id);
  return { found: true, cancellable: true };
}

export function resetInterruptedJobs() {
  return stmts.resetPrinting.run(Date.now());
}

export function getJobCounts() {
  const rows = stmts.countByStatus.all();
  const counts = { queued: 0, printing: 0, failed: 0, dead: 0, done: 0 };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

export function listJobsForLogs(filters = {}) {
  const conditions = ['1=1'];
  const params = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.printer_id) {
    conditions.push('printer_id = ?');
    params.push(filters.printer_id);
  }
  if (filters.from) {
    conditions.push('created_at >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('created_at <= ?');
    params.push(filters.to);
  }

  const where = conditions.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) as count FROM print_jobs WHERE ${where}`).get(...params).count;

  const limit = Math.min(Math.max(filters.limit || 100, 1), 500);
  const offset = Math.max(filters.offset || 0, 0);

  const jobs = db.prepare(
    `SELECT id, printer_id, usb_path, status, attempts, max_attempts, error, round_id, restaurant_id, session_id, job_type, created_at, updated_at, next_retry_at
     FROM print_jobs WHERE ${where}
     ORDER BY created_at DESC
     LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  return { total, limit, offset, jobs };
}

export function listDeadJobsForPrinter(usbPath) {
  return stmts.deadJobsForPrinter.all(usbPath);
}

export function getStaleQueuedForPath(usbPath, cutoffMs) {
  const cutoffTimestamp = Date.now() - cutoffMs;
  return db.prepare(`
    SELECT id, printer_id, usb_path, round_id, restaurant_id, session_id, job_type, created_at
    FROM print_jobs
    WHERE usb_path = ?
      AND status = 'queued'
      AND created_at < ?
  `).all(usbPath, cutoffTimestamp);
}

export function jobExists(id) {
  return !!stmts.getJob.get(id);
}
