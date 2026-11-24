# Running PiFi on a Raspberry Pi with systemd

## 1. User, data directory, code

```bash
sudo useradd --system --create-home --shell /usr/sbin/nologin pifi
sudo install -d -o pifi -g pifi -m 700 /var/lib/pifi
sudo git clone https://github.com/<you>/PiFi_Runtime /opt/pifi
sudo chown -R pifi:pifi /opt/pifi
sudo -u pifi bash -c 'cd /opt/pifi && npm ci && npm run build'
```

Node 20+ is required (22 LTS recommended), on **64-bit** Raspberry Pi OS.

### WebRTC library check (`node-datachannel`)

Direct phone connections use `node-datachannel` (libdatachannel). It ships
prebuilt binaries for Linux arm64 and x64; **there is no 32-bit ARM build**, so
use the 64-bit OS. The arm64 build needs OpenSSL 3 from the system, which
Raspberry Pi OS normally has. After `npm ci`, check:

```bash
openssl version                       # expect OpenSSL 3.x
node -e "import('node-datachannel').then(m => { console.log('node-datachannel', m.default.getLibraryVersion?.() ?? 'ok'); m.default.cleanup(); })"
```

If that fails (missing library, wrong architecture), apps and the control API
still work; only phone sessions are unavailable (the daemon loads the library
lazily, on the first session). The documented fallback is the pure-JavaScript
`werift` library behind the same `PeerTransport` interface
(`packages/runtime/src/peer.ts`); it isn't implemented yet.
**This has not yet been verified on real Pi hardware.** Code lives in `/opt/pifi`, data in
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
# Optional (Phase 3): name shown on phones, STUN/TURN servers, limits.
#Environment=PIFI_DEVICE_NAME=living-room-pi
#Environment=PIFI_ICE_SERVERS=["stun:stun.l.google.com:19302"]
#Environment=PIFI_MAX_SESSIONS=5
#Environment=PIFI_MAX_PAIRED_PHONES=10
#Environment=PIFI_SESSION_IDLE_SEC=45
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

**No secrets in this file.** TURN credentials, when used later, belong in an
`EnvironmentFile=` readable only by root/pifi, never in the repo. The identity key is created on first start in
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

`/var/lib/pifi/keys/identity.key` **is** the Pi's identity, and
`/var/lib/pifi/paired.json` lists the phones allowed to connect. If it is lost, the
Pi gets a new deviceId and every phone must pair again. If only one of the two
key files is present, PiFi refuses to start rather than silently replacing the identity.
