# MediaMonitor API

LAN-accessible REST API to track media requests through Seerr → ARR → SABnzbd → pull script → import → Plex.

## Dev (on host)

```bash
npm run migrate:dev
npm run dev
```

Then:
- `GET http://<server-ip-or-hostname>:8787/healthz`
- `POST http://<server-ip-or-hostname>:8787/admin/seed`

Example seed:

```bash
curl -X POST http://<server-ip-or-hostname>:8787/admin/seed \
  -H 'content-type: application/json' \
  -d '{"id":"demo-movie-1","type":"movie","title":"Example Movie","year":2026}'
```

## Docker

```bash
docker compose up --build
```

The container publishes `${API_PORT:-8787}` on the host (LAN-wide). If you run a firewall (e.g. `ufw`), allow inbound TCP on that port.

By default the server binds to `HOST=::` (IPv6 any). If you prefer IPv4-only, set `HOST=0.0.0.0`.

## Configuration reference

### Docker Compose (`.env`)

These are read by `docker-compose.yml` / `docker-compose.host-signals.yml` (see `.env.example`):

- **`API_PORT`**: host port published to the container’s internal `8787` (default `8787`).
- **`HOST`**: bind address inside the container (default `::`).
- **`LOG_LEVEL`**: log level passed to the app (default `info`).
- **`SQLITE_FILE`**: SQLite filename stored under the `/data` volume (default `mediamonitor.sqlite`).
- **`WEBHOOK_SECRET`**: shared secret for `/webhooks/*` (recommended).
- **`SABNZBD_PULL_LOG_PATH`**: host path to pull-script log (optional; used only with `docker-compose.host-signals.yml`).
- **`SABNZBD_PULL_STATE_PATH`**: host path to pull-script state JSON (optional; used only with `docker-compose.host-signals.yml`).
- **`PLEX_LOGS_PATH`**: host path to Plex Logs dir (optional; used only with `docker-compose.plex-logs.yml`).

### Application runtime (`src/config.ts`)

These are read by the Node process (set them in Compose `environment:` for Docker, or export them for local dev):

- **`PORT`**: listen port inside the container (Compose currently sets this to `8787`).
- **`HOST`**: listen address (default `::`).
- **`DATA_DIR`**: directory containing the SQLite DB file (Compose sets `/data`; local dev defaults to `./data`).
- **`SQLITE_FILE`**: SQLite filename inside `DATA_DIR` (default `mediamonitor.sqlite`).
- **`LOG_LEVEL`**: logging verbosity (default `info`).
- **`WEBHOOK_SECRET`**: enables webhook auth for `/webhooks/*` via `x-webhook-secret` **or** `?secret=` query param.
- **`POLL_INTERVAL_SECONDS`**: background poller interval (default `30`, minimum `5`).
- **`PLEX_MEDIA_SCANNER_LOG_INGEST_PATH`**: in-container path to Plex scanner log **directory** (recommended) or a specific log file (default `/host/plex-logs`).
- **Integrations (optional today; used by pollers as they’re implemented)**:
  - **`SEERR_BASE_URL`**, **`SEERR_API_KEY`**
  - **`SONARR_BASE_URL`**, **`SONARR_API_KEY`**
  - **`RADARR_BASE_URL`**, **`RADARR_API_KEY`**
  - **`SABNZBD_BASE_URL`**, **`SABNZBD_API_KEY`**
  - **`TAUTULLI_BASE_URL`**, **`TAUTULLI_API_KEY`**

### Notes

- **`NODE_ENV`**: when running locally with a TTY, `NODE_ENV` not equal to `production` enables prettier logs; Docker image sets `production` by default.
- **Admin endpoints** (`/admin/*`) are currently unauthenticated beyond LAN exposure—treat network access accordingly.

### Background pollers

The server periodically polls configured integrations (`POLL_INTERVAL_SECONDS`, default `30`) and appends timeline events.

- **Sonarr/Radarr**: polls `/api/v3/queue` and emits `*.poll.queue` events; also pings `/api/v3/system/status` first.
- **SABnzbd**: polls `mode=queue` and emits `sabnzbd.poll.queue` events when a job’s status changes (requires `downloadId` correlation from ARR webhooks).
- **Seerr**: polls `GET /api/v1/status` with `X-Api-Key`.
- **Tautulli**: polls `cmd=get_server_info`.
- **Plex scanner**: tails `Plex Media Scanner.log` and uses scan activity completion signals to advance `plex_scanning` → `available` (requires mounting Plex logs; see below).

`TAUTULLI_BASE_URL` should be the **web UI root** (scheme + host + port), e.g. `http://yourhost:8181` (optionally with a reverse-proxy subpath like `http://yourhost/tautulli`). The client will call `/api/v2` under that root.

You can also trigger a poll cycle immediately:

- `POST /admin/sync`

## Webhook secret (recommended)

Don’t commit secrets into the repo. Docker Compose will automatically load a local `.env` file (which is gitignored here).

1) Copy `.env.example` to `.env` and edit it:

```bash
cp .env.example .env
```

2) Restart:

```bash
docker compose up -d --build
```

3) Configure Sonarr/Radarr/Seerr to send header:

`x-webhook-secret: <same value>`

If a webhook sender can’t add custom headers (some Seerr builds are limited here), use a query param instead:

`http://<server-ip-or-hostname>:8787/webhooks/seerr?secret=<same value>`

## Cleanup old uncorrelated items

If you have legacy `seerr:*` work-items created before correlation was enabled (or from test notifications), you can prune them.

- Dry-run (recommended first):

```bash
curl -X POST http://<server-ip-or-hostname>:8787/admin/prune \
  -H 'content-type: application/json' \
  -d '{"idPrefix":"seerr:","olderThanDays":1,"dryRun":true,"onlyUncorrelated":true}'
```

- Execute deletion:

```bash
curl -X POST http://<server-ip-or-hostname>:8787/admin/prune \
  -H 'content-type: application/json' \
  -d '{"idPrefix":"seerr:","olderThanDays":1,"dryRun":false,"onlyUncorrelated":true}'
```

## Optional: mount host “signal” files (pull script log/state)

If you want the container to read host log/state files, run with the additional compose file and set the paths in `.env`:

```bash
docker compose -f docker-compose.yml -f docker-compose.host-signals.yml up -d --build
```

## Optional: mount Plex logs (for Plex scan detection)

If you want the server to detect Plex library scans (stage `plex_scanning` → `available`), mount the Plex Logs directory read-only:

```bash
docker compose -f docker-compose.yml -f docker-compose.plex-logs.yml up -d --build
```

Then set `PLEX_LOGS_PATH` in `.env` to your Plex logs folder (example on many Linux installs):

- `/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Logs`

By default, the container will read `PLEX_MEDIA_SCANNER_LOG_INGEST_PATH=/host/plex-logs` and automatically tail the newest `Plex Media Scanner*.log` file (handles rotation like `Plex Media Scanner.1.log`).


