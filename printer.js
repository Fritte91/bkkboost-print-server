import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import logger from './logger.js';

export async function writeToPrinter(usbPath, buffer) {
  const fd = await fs.open(usbPath, 'w');
  try {
    await fd.write(buffer);
  } finally {
    await fd.close();
  }
}

export async function isPrinterConnected(usbPath) {
  try {
    await fs.access(usbPath);
    return true;
  } catch {
    return false;
  }
}

export async function getPrinterStatuses(printers) {
  return Promise.all(
    printers.map(async (p) => ({
      printer_id: p.printer_id,
      name: p.name,
      usb_path: p.usb_path,
      connected: await isPrinterConnected(p.usb_path),
    }))
  );
}
