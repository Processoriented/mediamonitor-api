import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { sabnzbdHistory, sabnzbdQueue } from "../../integrations/sabnzbdClient.js";
import { appendEvent, getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { findWorkItemIdByExternalId } from "../../db/repos/externalIdsRepo.js";
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

type Slot = { nzo_id?: string; filename?: string; status?: string; mb?: string };

function snapshotQueueSlots(queue: any): Record<string, string> {
  const slots = (queue?.queue?.slots ?? []) as Slot[];
  const out: Record<string, string> = {};
  for (const s of slots) {
    if (!s?.nzo_id) continue;
    out[s.nzo_id] = String(s.status ?? "");
  }
  return out;
}

export async function pollSabnzbd(db: Db, cfg: AppConfig) {
  if (!cfg.SABNZBD_BASE_URL || !cfg.SABNZBD_API_KEY) return;

  const queue = await sabnzbdQueue({ baseUrl: cfg.SABNZBD_BASE_URL, apiKey: cfg.SABNZBD_API_KEY });
  const prevRaw = getPollState(db, "sabnzbd:queue_snapshot");
  const prev = prevRaw ? (JSON.parse(prevRaw) as Record<string, string>) : {};
  const next = snapshotQueueSlots(queue);

  for (const [nzoId, status] of Object.entries(next)) {
    const prevStatus = prev[nzoId];
    if (prevStatus === status) continue;

    const downloadId = `SABnzbd_${nzoId}`;
    const workItemId =
      findWorkItemIdByExternalId(db, { source: "sabnzbd", externalType: "download_id", externalId: downloadId }) ??
      findWorkItemIdByExternalId(db, { source: "sabnzbd", externalType: "nzo_id", externalId: nzoId });

    if (!workItemId) continue;

    upsertStage(db, workItemId, "downloading");
    appendEvent(db, workItemId, {
      ts: nowIso(),
      type: "sabnzbd.poll.queue",
      source: "sabnzbd",
      severity: "info",
      message: "SABnzbd queue poll",
      data: { nzoId, status, prevStatus, downloadId }
    });
  }

  setPollState(db, "sabnzbd:queue_snapshot", JSON.stringify(next));

  // Lightweight “still alive” signal + future expansion point
  await sabnzbdHistory({ baseUrl: cfg.SABNZBD_BASE_URL, apiKey: cfg.SABNZBD_API_KEY });
  markIntegrationOk(db, "sabnzbd");
}
