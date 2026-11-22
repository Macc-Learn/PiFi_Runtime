# Running PiFi on a Raspberry Pi with systemd

## 1. User, data directory, code

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pifi
sudo install -d -o pifi -g pifi -m 700 /var/lib/pifi
sudo git clone https://github.com/<you>/PiFi_Runtime /opt/pifi
sudo chown -R pifi:pifi /opt/pifi
sudo -u pifi bash -c 'cd /opt/pifi && npm ci && npm run build'
```

Node 20+ is required (22 LTS recommended). Code lives in `/opt/pifi`, data in
`/var/lib/pifi`, so updating the code never touches keys, tokens or app data.

## 2. The unit file

`/etc/systemd/system/pifi.service`:

```ini
[Unit]
Description=PiFi runtime
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=pifi
Group=pifi
Environment=PIFI_HOME=/var/lib/pifi
Environment=PIFI_SIGNAL_URL=wss://your-signal-server.example/ws
ExecStart=/usr/bin/node /opt/pifi/packages/runtime/dist/src/cli.js daemon
Restart=on-failure
RestartSec=5
# PiFi stops apps gracefully on SIGTERM (shutdown message, then SIGTERM, then SIGKILL: ~10 s per app, in parallel).
KillSignal=SIGTERM
TimeoutStopSec=30

# Hardening. Loosen ReadWritePaths if an app needs to write elsewhere (e.g. a storage disk).
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
ReadWritePaths=/var/lib/pifi

[Install]
WantedBy=multi-user.target
```

**No secrets in this file.** The identity key is created on first start in
`/var/lib/pifi/keys/` (directory `0700`, key `0600`) and never leaves it; the
admin token is in `/var/lib/pifi/admin.token`. The signal URL isn't a secret.

## 3. Start it

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pifi
journalctl -u pifi -f
sudo -u pifi PIFI_HOME=/var/lib/pifi node /opt/pifi/packages/runtime/dist/src/cli.js status
```

`pifi status` shows `signaling  online since …` once the Pi has registered.
Leave `PIFI_SIGNAL_URL` out to run without signaling (Phase 1 behaviour).
Don't set `PIFI_DEV=1` on a real device: it disables app hash checks.

## 4. Back up the identity

`/var/lib/pifi/keys/identity.key` **is** the Pi's identity. If it is lost, the
Pi gets a new deviceId and every phone must pair again. If only one of the two
key files is present, PiFi refuses to start rather than silently replacing the identity.
