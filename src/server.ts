import Fastify from "fastify";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { loadConfig } from "./config.js";
import { runMigrations } from "./db/migrate.js";
import { openDb } from "./db/db.js";
import { appendEvent, getTimeline, getWorkItem, listWorkItems, upsertWorkItem } from "./db/repos/workItemsRepo.js";
import { registerWebhooks } from "./ingest/webhooks.js";
import { startPollLoop } from "./ingest/pollers.js";

const cfg = loadConfig();
const logger = createLogger();

runMigrations();
const db = openDb();

const app = Fastify({
  logger: {
    level: cfg.LOG_LEVEL,
    transport:
      process.stdout.isTTY && process.env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "SYS:standard" }
          }
        : undefined
  }
});

app.get("/healthz", async () => {
  return { ok: true };
});

app.get("/integrations", async () => {
  const rows = db.prepare("select * from integration_sync_state order by integration asc").all();
  return { integrations: rows };
});

app.post("/admin/sync", async () => {
  // Minimal hook point; for now it just indicates the server is alive.
  // Next iteration will run pollers immediately.
  return { ok: true };
});

app.get("/work-items", async (req) => {
  const querySchema = z.object({
    stage: z.string().optional(),
    health: z.string().optional(),
    type: z.string().optional(),
    q: z.string().optional(),
    updatedSince: z.string().optional()
  });
  const q = querySchema.parse(req.query);
  const items = listWorkItems(db, q);
  return { items };
});

app.get("/work-items/:id", async (req, reply) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const item = getWorkItem(db, params.id);
  if (!item) return reply.code(404).send({ error: "not_found" });
  return { item };
});

app.get("/work-items/:id/timeline", async (req, reply) => {
  const params = z.object({ id: z.string().min(1) }).parse(req.params);
  const item = getWorkItem(db, params.id);
  if (!item) return reply.code(404).send({ error: "not_found" });
  const timeline = getTimeline(db, params.id).map((r) => ({
    ts: r.ts,
    type: r.type,
    source: r.source,
    severity: r.severity,
    message: r.message ?? undefined,
    data: r.data_json ? JSON.parse(r.data_json) : undefined
  }));
  return { item, timeline };
});

// Temporary “seed” endpoint so you can see the model working end-to-end.
// We’ll replace this with real webhook/poller ingestion next.
app.post("/admin/seed", async (req) => {
  const body = z
    .object({
      id: z.string().min(1),
      type: z.enum(["movie", "episode"]),
      title: z.string().optional(),
      year: z.number().int().optional(),
      season: z.number().int().optional(),
      episode: z.number().int().optional()
    })
    .parse(req.body);

  upsertWorkItem(db, {
    id: body.id,
    type: body.type,
    title: body.title ?? null,
    year: body.year ?? null,
    season: body.season ?? null,
    episode: body.episode ?? null,
    stage: "requested",
    health: "ok",
    stalled_since: null,
    stall_reason: null,
    expected_next_event: "arr.grabbed"
  });

  appendEvent(db, body.id, {
    ts: new Date().toISOString(),
    type: "seed.created",
    source: "admin",
    severity: "info",
    message: "Seeded work item",
    data: { ...body }
  });

  return { ok: true };
});

await registerWebhooks(app, db, { secret: cfg.WEBHOOK_SECRET });

startPollLoop(db, { logger: app.log, intervalSeconds: cfg.POLL_INTERVAL_SECONDS });

await app.listen({ host: cfg.HOST, port: cfg.PORT });

