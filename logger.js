import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'print-server.log');
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED = 3;

fs.mkdirSync(LOG_DIR, { recursive: true });

function rotate() {
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size < MAX_SIZE) return;
  } catch {
    return;
  }

  for (let i = MAX_ROTATED; i >= 1; i--) {
    const older = `${LOG_FILE}.${i}`;
    const newer = i === 1 ? LOG_FILE : `${LOG_FILE}.${i - 1}`;
    try {
      if (i === MAX_ROTATED) fs.unlinkSync(older).catch?.(() => {});
    } catch {}
    try {
      fs.renameSync(newer, older);
    } catch {}
  }
}

function write(level, message) {
  rotate();
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, line);
  if (level === 'error') {
    process.stderr.write(line);
  } else {
    process.stdout.write(line);
  }
}

const logger = {
  info: (msg) => write('info', msg),
  warn: (msg) => write('warn', msg),
  error: (msg) => write('error', msg),
};

export default logger;
