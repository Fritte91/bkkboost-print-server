import fs from 'node:fs/promises';
import net from 'node:net';
import logger from './logger.js';

const CONNECT_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2000;

export async function writeToPrinter(printer, buffer) {
  if (printer.connection_type === 'wifi') {
    return writeToWifiPrinter(printer.ip_address, printer.port, buffer);
  }
  return writeToUsbPrinter(printer.usb_device_path, buffer);
}

async function writeToUsbPrinter(usbPath, buffer) {
  if (!usbPath) throw new Error('USB printer missing usb_device_path');
  if (!usbPath.startsWith('/dev/')) {
    throw new Error(`Invalid USB path: ${usbPath} (must start with /dev/)`);
  }
  const fd = await fs.open(usbPath, 'w');
  try {
    await fd.write(buffer);
  } finally {
    await fd.close();
  }
}

async function writeToWifiPrinter(host, port, buffer) {
  if (!host || !port) throw new Error('WiFi printer missing ip_address or port');
  if (!net.isIPv4(host)) throw new Error(`Invalid IPv4 address: ${host}`);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port, timeout: CONNECT_TIMEOUT_MS }, () => {
      socket.write(buffer, (err) => {
        if (err) {
          socket.destroy();
          return reject(err);
        }
        socket.end();
        resolve();
      });
    });
    socket.on('error', (err) => {
      socket.destroy();
      reject(err);
    });
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error(`WiFi printer timeout: ${host}:${port}`));
    });
  });
}

export async function isPrinterConnected(printer) {
  if (printer.connection_type === 'wifi') {
    return checkWifiPrinter(printer.ip_address, printer.port);
  }
  return checkUsbPrinter(printer.usb_device_path);
}

async function checkUsbPrinter(usbPath) {
  if (!usbPath) return false;
  try {
    await fs.access(usbPath);
    return true;
  } catch {
    return false;
  }
}

async function checkWifiPrinter(host, port) {
  if (!host || !port) return false;
  if (!net.isIPv4(host)) {
    logger.debug(`WiFi probe skipped: invalid IPv4 ${host}`);
    return false;
  }
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: PROBE_TIMEOUT_MS });
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(true));
    socket.once('error', (err) => {
      logger.debug(`WiFi probe error ${host}:${port}: ${err.code || err.message}`);
      done(false);
    });
    socket.once('timeout', () => {
      logger.debug(`WiFi probe timeout ${host}:${port}`);
      done(false);
    });
  });
}

export async function getPrinterStatuses(printers) {
  return Promise.all(
    printers.map(async (p) => ({
      printer_id: p.printer_id,
      name: p.name,
      connection_type: p.connection_type,
      ip_address: p.ip_address ?? null,
      port: p.port ?? null,
      usb_device_path: p.usb_device_path ?? null,
      connected: await isPrinterConnected(p),
    }))
  );
}
