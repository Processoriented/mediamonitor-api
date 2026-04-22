import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { Db } from "../db/db.js";
import { randomUUID } from "node:crypto";
import { appendEvent, getWorkItem, upsertWorkItem } from "../db/repos/workItemsRepo.js";
import type { Stage } from "../domain/types.js";
import { findWorkItemIdByExternalId, upsertExternalId } from "../db/repos/externalIdsRepo.js";

function requireWebhookSecret(secret?: string) {
  return async (req: any, reply: any) => {
    if (!secret) return;
    const gotHeader = req.headers["x-webhook-secret"];
    const gotQuery = typeof req.query?.secret === "string" ? req.query.secret : undefined;
    // Some webhook senders can't add custom headers; support a query param fallback.
    if (gotHeader !== secret && gotQuery !== secret) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function stageForArrEvent(eventType?: string): Stage {
  const t = (eventType ?? "").toLowerCase();
  if (t.includes("grab")) return "downloading";
  if (t.includes("download")) return "downloading";
  if (t.includes("import")) return "importing";
  if (t.includes("rename")) return "imported";
  if (t.includes("health")) return "searching";
  return "searching";
}

function upsertTmdbMovieCorrelation(db: Db, tmdbId: number, workItemId: string) {
  upsertExternalId(db, { source: "tmdb", externalType: "movie", externalId: String(tmdbId), workItemId });
}

function upsertSeerrRequestCorrelation(db: Db, requestId: number, workItemId: string) {
  upsertExternalId(db, { source: "seerr", externalType: "request", externalId: String(requestId), workItemId });
}

function upsertSeerrMediaCorrelation(db: Db, args: { mediaType: string; tmdbId?: number; tvdbId?: number; workItemId: string }) {
  const mt = args.mediaType.toLowerCase();
  if (mt === "movie" && args.tmdbId) {
    upsertExternalId(db, { source: "seerr", externalType: "tmdb_movie", externalId: String(args.tmdbId), workItemId: args.workItemId });
  }
  if ((mt === "tv" || mt === "series") && args.tvdbId) {
    upsertExternalId(db, { source: "seerr", externalType: "tvdb_series", externalId: String(args.tvdbId), workItemId: args.workItemId });
  }
}

export async function registerWebhooks(app: FastifyInstance, db: Db, opts: { secret?: string }) {
  const auth = requireWebhookSecret(opts.secret);

  // These webhook payloads vary by product/version and user config; we ingest
  // them as “opaque” events first. Correlation comes next iteration.
  const seerrBody = z
    .object({
      notification_type: z.string().optional(),
      event: z.string().optional(),
      subject: z.string().optional(),
      message: z.string().optional(),
      media: z
        .object({
          mediaType: z.string().optional(),
          tmdbId: z.number().int().optional(),
          tvdbId: z.number().int().optional()
        })
        .passthrough()
        .optional(),
      request: z
        .object({
          id: z.number().int().optional(),
          type: z.string().optional(),
          media: z
            .object({
              mediaType: z.string().optional(),
              tmdbId: z.number().int().optional(),
              tvdbId: z.number().int().optional()
            })
            .passthrough()
            .optional()
        })
        .passthrough()
        .optional()
    })
    .passthrough();

  const radarrBody = z
    .object({
      eventType: z.string().optional(),
      instanceName: z.string().optional(),
      movie: z
        .object({
          id: z.number().int(),
          title: z.string().optional(),
          year: z.number().int().optional(),
          tmdbId: z.number().int().optional()
        })
        .optional(),
      remoteMovie: z
        .object({
          title: z.string().optional(),
          year: z.number().int().optional(),
          tmdbId: z.number().int().optional(),
          imdbId: z.string().optional()
        })
        .optional(),
      release: z.unknown().optional()
    })
    .passthrough();

  const sonarrBody = z
    .object({
      eventType: z.string().optional(),
      instanceName: z.string().optional(),
      series: z
        .object({
          id: z.number().int(),
          title: z.string().optional(),
          year: z.number().int().optional(),
          tvdbId: z.number().int().optional(),
          tmdbId: z.number().int().optional()
        })
        .optional(),
      episodes: z
        .array(
          z
            .object({
              id: z.number().int(),
              seasonNumber: z.number().int().optional(),
              episodeNumber: z.number().int().optional(),
              title: z.string().optional()
            })
            .passthrough()
        )
        .optional()
    })
    .passthrough();

  app.post("/webhooks/seerr", { preHandler: auth }, async (req) => {
    const body = seerrBody.parse(req.body);
    const notif = (body.notification_type ?? "").toUpperCase();

    // Test notifications don’t include stable media/request identifiers.
    if (notif.includes("TEST")) {
      const workItemId = `seerr:${randomUUID()}`;
      upsertWorkItem(db, {
        id: workItemId,
        type: "movie",
        title: body.subject ?? null,
        year: null,
        season: null,
        episode: null,
        stage: "requested",
        health: "ok",
        stalled_since: null,
        stall_reason: null,
        expected_next_event: "arr.grabbed"
      });
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: "seerr.webhook.test",
        source: "seerr",
        severity: "info",
        message: "Seerr test notification",
        data: body
      });
      return { ok: true, workItemId };
    }

    const mediaType = (body.request?.media?.mediaType ?? body.media?.mediaType ?? "").toLowerCase();
    const tmdbId = body.request?.media?.tmdbId ?? body.media?.tmdbId;
    const tvdbId = body.request?.media?.tvdbId ?? body.media?.tvdbId;
    const requestId = body.request?.id;

    // Prefer correlating to the canonical ARR work item when possible.
    let workItemId: string | undefined;
    if (mediaType === "movie" && tmdbId) {
      workItemId = findWorkItemIdByExternalId(db, { source: "tmdb", externalType: "movie", externalId: String(tmdbId) });
    }

    if (!workItemId) {
      workItemId = `seerr:${randomUUID()}`;
    }

    const type: "movie" | "episode" = mediaType === "movie" ? "movie" : "episode";

    const existing = getWorkItem(db, workItemId);
    const correlatedToArr = workItemId.startsWith("radarr:") || workItemId.startsWith("sonarr:");
    // If we correlated to an existing ARR work item, do not overwrite its metadata.
    upsertWorkItem(db, {
      id: workItemId,
      type: (existing?.type as any) ?? type,
      title: correlatedToArr ? existing?.title ?? null : existing?.title ?? body.subject ?? null,
      year: correlatedToArr ? existing?.year ?? null : existing?.year ?? null,
      season: existing?.season ?? null,
      episode: existing?.episode ?? null,
      stage: existing?.stage ?? "requested",
      health: existing?.health ?? "ok",
      stalled_since: existing?.stalled_since ?? null,
      stall_reason: existing?.stall_reason ?? null,
      expected_next_event: existing?.expected_next_event ?? "arr.grabbed"
    });

    if (requestId) upsertSeerrRequestCorrelation(db, requestId, workItemId);
    upsertSeerrMediaCorrelation(db, { mediaType, tmdbId, tvdbId, workItemId });

    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: `seerr.webhook.${notif || "UNKNOWN"}`,
      source: "seerr",
      severity: "info",
      message: workItemId.startsWith("seerr:") ? "Seerr webhook (no correlation yet)" : "Seerr webhook correlated",
      data: body
    });
    return { ok: true, workItemId };
  });

  app.post("/webhooks/sonarr", { preHandler: auth }, async (req) => {
    const body = sonarrBody.parse(req.body);
    const eventType = body.eventType ?? "unknown";
    const stage = stageForArrEvent(eventType);

    const episodes = body.episodes ?? [];
    if (episodes.length === 0) {
      const workItemId = `sonarr:${randomUUID()}`;
      upsertWorkItem(db, {
        id: workItemId,
        type: "episode",
        title: body.series?.title ?? null,
        year: body.series?.year ?? null,
        season: null,
        episode: null,
        stage,
        health: "ok",
        stalled_since: null,
        stall_reason: null,
        expected_next_event: null
      });
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: `sonarr.webhook.${eventType}`,
        source: "sonarr",
        severity: "info",
        message: "Received Sonarr webhook (uncorrelated; no episodes array)",
        data: body
      });
      return { ok: true, workItemIds: [workItemId] };
    }

    const workItemIds: string[] = [];
    for (const ep of episodes) {
      const workItemId = `sonarr:episode:${ep.id}`;
      workItemIds.push(workItemId);
      upsertWorkItem(db, {
        id: workItemId,
        type: "episode",
        title: body.series?.title ?? null,
        year: body.series?.year ?? null,
        season: ep.seasonNumber ?? null,
        episode: ep.episodeNumber ?? null,
        stage,
        health: "ok",
        stalled_since: null,
        stall_reason: null,
        expected_next_event: null
      });
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: `sonarr.webhook.${eventType}`,
        source: "sonarr",
        severity: "info",
        message: "Received Sonarr webhook",
        data: body
      });
    }
    return { ok: true, workItemIds };
  });

  app.post("/webhooks/radarr", { preHandler: auth }, async (req) => {
    const body = radarrBody.parse(req.body);
    const eventType = body.eventType ?? "unknown";
    const stage = stageForArrEvent(eventType);

    const movieId = body.movie?.id;
    const workItemId = movieId != null ? `radarr:movie:${movieId}` : `radarr:${randomUUID()}`;

    upsertWorkItem(db, {
      id: workItemId,
      type: "movie",
      title: body.movie?.title ?? body.remoteMovie?.title ?? null,
      year: body.movie?.year ?? body.remoteMovie?.year ?? null,
      season: null,
      episode: null,
      stage,
      health: "ok",
      stalled_since: null,
      stall_reason: null,
      expected_next_event: null
    });
    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: `radarr.webhook.${eventType}`,
      source: "radarr",
      severity: "info",
      message: "Received Radarr webhook",
      data: body
    });

    const tmdb =
      body.movie?.tmdbId ??
      body.remoteMovie?.tmdbId ??
      (typeof (body as any).tmdbId === "number" ? (body as any).tmdbId : undefined);
    if (tmdb) upsertTmdbMovieCorrelation(db, tmdb, workItemId);

    return { ok: true, workItemId };
  });
}

