import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { arrHistory, arrQueue } from "../../integrations/arrClient.js";
import { appendEvent, getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { markIntegrationOk } from "../../db/repos/integrationsRepo.js";
import type { Stage } from "../../domain/types.js";
import { getPollState, setPollState } from "../../db/repos/pollStateRepo.js";

function nowIso() {
  return new Date().toISOString();
}

function mergeStage(current: Stage | undefined, next: Stage): Stage {
  if (!current) return next;
  const order: Stage[] = ["requested", "searching", "downloading", "pulling", "importing", "imported", "plex_scanning", "available"];
  const ci = order.indexOf(current);
  const ni = order.indexOf(next);
  if (ci === -1) return next;
  if (ni === -1) return current;
  return ni > ci ? next : current;
}

function upsertStage(db: Db, workItemId: string, nextStage: Stage) {
  const existing = getWorkItem(db, workItemId);
  if (!existing) return;
  const stage = mergeStage(existing.stage as Stage, nextStage);
  upsertWorkItem(db, {
    id: workItemId,
    type: existing.type,
    title: existing.title,
    year: existing.year,
    season: existing.season,
    episode: existing.episode,
    stage,
    health: existing.health,
    stalled_since: existing.stalled_since,
    stall_reason: existing.stall_reason,
    expected_next_event: existing.expected_next_event
  });
}

function setHealthFailed(db: Db, workItemId: string, reason: string) {
  const existing = getWorkItem(db, workItemId);
  if (!existing) return;
  upsertWorkItem(db, {
    id: workItemId,
    type: existing.type,
    title: existing.title,
    year: existing.year,
    season: existing.season,
    episode: existing.episode,
    stage: existing.stage,
    health: "failed",
    stalled_since: existing.stalled_since,
    stall_reason: reason,
    expected_next_event: existing.expected_next_event
  });
}

function stageForHistoryEventType(eventType: string): Stage | undefined {
  const t = eventType.toLowerCase();
  if (t.includes("grab")) return "downloading";
  if (t.includes("download")) return "downloading";
  if (t.includes("import")) return "imported";
  if (t.includes("rename")) return "imported";
  return undefined;
}

function shouldEmitHistory(db: Db, key: string, id: number) {
  const prev = Number(getPollState(db, key) ?? "0");
  return !(Number.isFinite(prev) && id <= prev);
}

function bumpHistoryWatermark(db: Db, key: string, id: number) {
  const prev = Number(getPollState(db, key) ?? "0");
  const next = Math.max(Number.isFinite(prev) ? prev : 0, id);
  setPollState(db, key, String(next));
}

function ensureSonarrEpisodeWorkItem(db: Db, r: any, episodeId: number) {
  const workItemId = `sonarr:episode:${episodeId}`;
  const existing = getWorkItem(db, workItemId);
  if (existing) return workItemId;

  const seriesTitle = r.series?.title ?? r.title ?? null;
  const year = typeof r.series?.year === "number" ? r.series.year : null;
  const season = typeof r.episode?.seasonNumber === "number" ? r.episode.seasonNumber : typeof r.seasonNumber === "number" ? r.seasonNumber : null;
  const episode = typeof r.episode?.episodeNumber === "number" ? r.episode.episodeNumber : typeof r.episodeNumber === "number" ? r.episodeNumber : null;

  upsertWorkItem(db, {
    id: workItemId,
    type: "episode",
    title: seriesTitle,
    year,
    season,
    episode,
    stage: "searching",
    health: "ok",
    stalled_since: null,
    stall_reason: null,
    expected_next_event: null
  });

  appendEvent(db, workItemId, {
    ts: nowIso(),
    type: "sonarr.poll.bootstrap",
    source: "sonarr",
    severity: "info",
    message: "Created work item from Sonarr queue poll (no prior webhook)",
    data: { episodeId }
  });

  return workItemId;
}

function ensureRadarrMovieWorkItem(db: Db, r: any, movieId: number) {
  const workItemId = `radarr:movie:${movieId}`;
  const existing = getWorkItem(db, workItemId);
  if (existing) return workItemId;

  const title = r.movie?.title ?? r.title ?? null;
  const year = typeof r.movie?.year === "number" ? r.movie.year : null;

  upsertWorkItem(db, {
    id: workItemId,
    type: "movie",
    title,
    year,
    season: null,
    episode: null,
    stage: "searching",
    health: "ok",
    stalled_since: null,
    stall_reason: null,
    expected_next_event: null
  });

  appendEvent(db, workItemId, {
    ts: nowIso(),
    type: "radarr.poll.bootstrap",
    source: "radarr",
    severity: "info",
    message: "Created work item from Radarr queue poll (no prior webhook)",
    data: { movieId }
  });

  return workItemId;
}

export async function pollSonarrQueue(db: Db, cfg: AppConfig) {
  if (!cfg.SONARR_BASE_URL || !cfg.SONARR_API_KEY) return;
  const q = await arrQueue({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
  const records = (q.records ?? []) as any[];

  for (const r of records) {
    const epId = r.episodeId ?? r.episode?.id;
    if (!epId) continue;
    const workItemId = ensureSonarrEpisodeWorkItem(db, r, epId);
    upsertStage(db, workItemId, "downloading");
    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: "sonarr.poll.queue",
      source: "sonarr",
      severity: "info",
      message: "Sonarr queue poll",
      data: {
        status: r.status,
        trackedDownloadStatus: r.trackedDownloadStatus,
        trackedDownloadState: r.trackedDownloadState,
        title: r.title,
        downloadId: r.downloadId
      }
    });
  }

  const hist = await arrHistory({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
  const histRecords = (hist.records ?? []) as any[];
  const watermarkKey = "sonarr:history:last_id";
  let maxId = 0;
  for (const r of histRecords) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    maxId = Math.max(maxId, id);
    if (!shouldEmitHistory(db, watermarkKey, id)) continue;

    const epId = r.episodeId;
    if (!epId) continue;
    const workItemId = ensureSonarrEpisodeWorkItem(db, r, epId);
    const et = String(r.eventType ?? "unknown");
    const stage = stageForHistoryEventType(et);
    if (stage) upsertStage(db, workItemId, stage);

    const lower = et.toLowerCase();
    if (lower.includes("failed")) setHealthFailed(db, workItemId, `sonarr.history.${et}`);

    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: `sonarr.poll.history.${et}`,
      source: "sonarr",
      severity: lower.includes("failed") ? "error" : "info",
      message: "Sonarr history poll",
      data: { id, eventType: et, downloadId: r.downloadId, sourceTitle: r.sourceTitle, data: r.data }
    });
  }
  if (maxId) bumpHistoryWatermark(db, watermarkKey, maxId);
  markIntegrationOk(db, "sonarr");
}

export async function pollRadarrQueue(db: Db, cfg: AppConfig) {
  if (!cfg.RADARR_BASE_URL || !cfg.RADARR_API_KEY) return;
  const q = await arrQueue({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
  const records = (q.records ?? []) as any[];

  for (const r of records) {
    const movieId = r.movieId ?? r.movie?.id;
    if (!movieId) continue;
    const workItemId = ensureRadarrMovieWorkItem(db, r, movieId);
    upsertStage(db, workItemId, "downloading");
    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: "radarr.poll.queue",
      source: "radarr",
      severity: "info",
      message: "Radarr queue poll",
      data: {
        status: r.status,
        trackedDownloadStatus: r.trackedDownloadStatus,
        trackedDownloadState: r.trackedDownloadState,
        title: r.title,
        downloadId: r.downloadId
      }
    });
  }

  const hist = await arrHistory({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
  const histRecords = (hist.records ?? []) as any[];
  const watermarkKey = "radarr:history:last_id";
  let maxId = 0;
  for (const r of histRecords) {
    const id = Number(r.id);
    if (!Number.isFinite(id)) continue;
    maxId = Math.max(maxId, id);
    if (!shouldEmitHistory(db, watermarkKey, id)) continue;

    const movieId = r.movieId;
    if (!movieId) continue;
    const workItemId = ensureRadarrMovieWorkItem(db, r, movieId);
    const et = String(r.eventType ?? "unknown");
    const stage = stageForHistoryEventType(et);
    if (stage) upsertStage(db, workItemId, stage);

    const lower = et.toLowerCase();
    if (lower.includes("failed")) setHealthFailed(db, workItemId, `radarr.history.${et}`);

    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: `radarr.poll.history.${et}`,
      source: "radarr",
      severity: lower.includes("failed") ? "error" : "info",
      message: "Radarr history poll",
      data: { id, eventType: et, downloadId: r.downloadId, sourceTitle: r.sourceTitle, data: r.data }
    });
  }
  if (maxId) bumpHistoryWatermark(db, watermarkKey, maxId);
  markIntegrationOk(db, "radarr");
}
