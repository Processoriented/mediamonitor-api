import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import type { Stage } from "../../domain/types.js";
import { getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { markIntegrationOk } from "../../db/repos/integrationsRepo.js";

type WorkItemMini = {
  id: string;
  stage: Stage;
  health: "ok" | "stalled" | "failed";
  stalled_since: string | null;
  updated_at: string;
};

function msSince(iso: string) {
  return Date.now() - Date.parse(iso);
}

function thresholdMsForStage(stage: Stage) {
  // Balanced defaults from earlier planning.
  switch (stage) {
    case "downloading":
      return 2 * 60 * 60 * 1000; // 2h
    case "pulling":
      return 20 * 60 * 1000; // 20m
    case "importing":
      return 60 * 60 * 1000; // 60m
    case "plex_scanning":
      return 60 * 60 * 1000; // 60m
    case "requested":
    case "searching":
      return 2 * 60 * 60 * 1000; // 2h
    default:
      return 24 * 60 * 60 * 1000; // imported/available shouldn't stall; effectively never
  }
}

function expectedNextEventForStage(stage: Stage): string | null {
  switch (stage) {
    case "requested":
      return "arr.grabbed";
    case "searching":
      return "arr.grabbed";
    case "downloading":
      return "sab.completed";
    case "pulling":
      return "pull.rclone.check";
    case "importing":
      return "arr.import.succeeded";
    case "plex_scanning":
      return "plex.scan.completed";
    default:
      return null;
  }
}

export async function pollStallEngine(db: Db, _cfg: AppConfig) {
  // Evaluate only recent-ish items to keep it cheap.
  const items = db
    .prepare(
      `
      select id, stage, health, stalled_since, updated_at
      from work_items
      order by updated_at desc
      limit 500
    `
    )
    .all() as WorkItemMini[];

  // Latest event timestamp per work_item_id (for those 500 items).
  const latestEvent = new Map<string, string>();
  const latestRows = db
    .prepare(
      `
      select e.work_item_id as id, max(e.ts) as ts
      from events e
      where e.work_item_id in (select id from work_items order by updated_at desc limit 500)
      group by e.work_item_id
    `
    )
    .all() as Array<{ id: string; ts: string }>;
  for (const r of latestRows) latestEvent.set(r.id, r.ts);

  for (const wi of items) {
    // Use last event time if present; otherwise fall back to work_items.updated_at.
    const lastTs = latestEvent.get(wi.id) ?? wi.updated_at;
    const ageMs = msSince(lastTs);
    const thresholdMs = thresholdMsForStage(wi.stage);

    // If stalled, auto-clear when new progress arrives after stalled_since.
    if (wi.health === "stalled" && wi.stalled_since) {
      if (Date.parse(lastTs) > Date.parse(wi.stalled_since)) {
        const existing = getWorkItem(db, wi.id);
        if (!existing) continue;
        upsertWorkItem(db, {
          id: existing.id,
          type: existing.type,
          title: existing.title,
          year: existing.year,
          season: existing.season,
          episode: existing.episode,
          stage: existing.stage,
          health: "ok",
          stalled_since: null,
          stall_reason: null,
          expected_next_event: existing.expected_next_event
        });
      }
      continue;
    }

    // Skip items that are already failed unless they progress again (handled above via stalled; failures are manual for now).
    if (wi.health === "failed") continue;

    // Don't stall terminal stages.
    if (wi.stage === "imported" || wi.stage === "available") continue;

    if (ageMs > thresholdMs) {
      const existing = getWorkItem(db, wi.id);
      if (!existing) continue;
      upsertWorkItem(db, {
        id: existing.id,
        type: existing.type,
        title: existing.title,
        year: existing.year,
        season: existing.season,
        episode: existing.episode,
        stage: existing.stage,
        health: "stalled",
        stalled_since: existing.stalled_since ?? new Date().toISOString(),
        stall_reason: `no_progress:${existing.stage}`,
        expected_next_event: expectedNextEventForStage(existing.stage) ?? existing.expected_next_event
      });
    }
  }

  markIntegrationOk(db, "stall_engine");
}

