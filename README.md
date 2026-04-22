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

