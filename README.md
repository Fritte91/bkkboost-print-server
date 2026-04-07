# BKKBoost Print Server

Lightweight HTTP print server for USB thermal printers. Designed to run on a Dell Wyse 3040 thin client (Xubuntu, 2GB RAM, 8GB eMMC).

## Installation

```bash
# Clone the repo
git clone <your-repo-url> /home/bkkboost/bkkboost-print-server
cd /home/bkkboost/bkkboost-print-server

# Install dependencies
npm install --production

# Create and edit config
cp config.json.example config.json
nano config.json
```

Set your `auth_token`, `restaurant_id`, and configure each printer with its `printer_id` (matching Supabase) and `usb_path`.

## USB Printer Setup

### Find your printers

```bash
# List USB printer devices
ls -la /dev/usb/lp*

# If no devices appear, load the usblp module
sudo modprobe usblp

# See which printer is which
udevadm info -a -n /dev/usb/lp0 | grep -E 'manufacturer|product|serial'
```

### Set permissions with udev rules

Create `/etc/udev/rules.d/99-usb-printers.rules`:

```
SUBSYSTEM=="usb", DRIVER=="usblp", MODE="0666"
```

Then reload:

```bash
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Alternatively, add the `bkkboost` user to the `lp` group:

```bash
sudo usermod -aG lp bkkboost
```

## Systemd Setup

```bash
# Install the print server service
sudo cp systemd/bkkboost-print.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bkkboost-print

# Check status
sudo systemctl status bkkboost-print
sudo journalctl -u bkkboost-print -f
```

Or use the shortcut:

```bash
npm run install-service
sudo systemctl start bkkboost-print
```

## Cloudflare Tunnel Setup

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb

# Authenticate (one-time)
cloudflared tunnel login

# Create tunnel
cloudflared tunnel create bkkboost-print

# Configure tunnel — create ~/.cloudflared/config.yml:
# tunnel: <TUNNEL_ID>
# credentials-file: /home/bkkboost/.cloudflared/<TUNNEL_ID>.json
# ingress:
#   - hostname: print-<restaurant>.bkkboost.com
#     service: http://localhost:3000
#   - service: http_status:404

# Add DNS route
cloudflared tunnel route dns bkkboost-print print-<restaurant>.bkkboost.com

# Install the cloudflared service
sudo cp systemd/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared-bkkboost
```

## Updating

```bash
cd /home/bkkboost/bkkboost-print-server
git pull
npm install --production
sudo systemctl restart bkkboost-print
```

## API

All endpoints require `Authorization: Bearer <auth_token>`.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/print` | Submit a print job |
| GET | `/jobs` | List jobs (filter: `?status=`, `?printer_id=`) |
| GET | `/jobs/:id` | Get a single job |
| POST | `/jobs/:id/retry` | Retry a failed/dead job |
| DELETE | `/jobs/:id` | Cancel a queued job |
| GET | `/printers` | Live printer connection status |
| GET | `/health` | Server health + job counts |
