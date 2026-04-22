import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { arrHistory, arrQueue } from "../../integrations/arrClient.js";
import { appendEvent, getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { markIntegrationOk } from "../../db/repos/integrationsRepo.js";
import type { Stage } from "../../domain/types.js";

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

export async function pollSonarrQueue(db: Db, cfg: AppConfig) {
  if (!cfg.SONARR_BASE_URL || !cfg.SONARR_API_KEY) return;
  const q = await arrQueue({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
  const records = (q.records ?? []) as any[];

  for (const r of records) {
    const epId = r.episodeId ?? r.episode?.id;
    if (!epId) continue;
    const workItemId = `sonarr:episode:${epId}`;
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

  await arrHistory({ baseUrl: cfg.SONARR_BASE_URL, apiKey: cfg.SONARR_API_KEY });
  markIntegrationOk(db, "sonarr");
}

export async function pollRadarrQueue(db: Db, cfg: AppConfig) {
  if (!cfg.RADARR_BASE_URL || !cfg.RADARR_API_KEY) return;
  const q = await arrQueue({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
  const records = (q.records ?? []) as any[];

  for (const r of records) {
    const movieId = r.movieId ?? r.movie?.id;
    if (!movieId) continue;
    const workItemId = `radarr:movie:${movieId}`;
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

  await arrHistory({ baseUrl: cfg.RADARR_BASE_URL, apiKey: cfg.RADARR_API_KEY });
  markIntegrationOk(db, "radarr");
}
