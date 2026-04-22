# MediaMonitor API

LAN-accessible REST API to track media requests through Seerr → ARR → SABnzbd (argus) → pull script → import → Plex.

## Dev (on host)

```bash
export PATH="/home/vincent/.volta/bin:$PATH"
cd /home/vincent/Projects/MediaMonitor/mediamonitor-api
npm run migrate:dev
npm run dev
```

Then:
- `GET http://<olympia-ip>:8787/healthz`
- `POST http://<olympia-ip>:8787/admin/seed`

Example seed:

```bash
curl -X POST http://<olympia-ip>:8787/admin/seed \
  -H 'content-type: application/json' \
  -d '{"id":"demo-movie-1","type":"movie","title":"Example Movie","year":2026}'
```

## Docker

```bash
cd /home/vincent/Projects/MediaMonitor/mediamonitor-api
docker compose up --build
```

The container publishes `8787` on the host (LAN-wide). If you run a firewall (e.g. `ufw`), allow inbound TCP `8787`.

By default the server binds to `HOST=::` (IPv6 any). If you prefer IPv4-only, set `HOST=0.0.0.0`.

## Webhook secret (recommended)

Don’t commit secrets into the repo. Docker Compose will automatically load a local `.env` file (which is gitignored here).

1) Create `mediamonitor-api/.env`:

```bash
WEBHOOK_SECRET="put-a-long-random-string-here"
```

2) Restart:

```bash
docker compose up -d --build
```

3) Configure Sonarr/Radarr/Seerr to send header:

`x-webhook-secret: <same value>`

If a webhook sender can’t add custom headers (some Seerr builds are limited here), use a query param instead:

`http://olympia.local:8787/webhooks/seerr?secret=<same value>`

## Cleanup old uncorrelated items

If you have legacy `seerr:*` work-items created before correlation was enabled (or from test notifications), you can prune them.

- Dry-run (recommended first):

```bash
curl -X POST http://olympia.local:8787/admin/prune \
  -H 'content-type: application/json' \
  -d '{"idPrefix":"seerr:","olderThanDays":1,"dryRun":true,"onlyUncorrelated":true}'
```

- Execute deletion:

```bash
curl -X POST http://olympia.local:8787/admin/prune \
  -H 'content-type: application/json' \
  -d '{"idPrefix":"seerr:","olderThanDays":1,"dryRun":false,"onlyUncorrelated":true}'
```

