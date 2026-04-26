import fs from "node:fs";
import path from "node:path";
import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { appendEvent, getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { getPollState, setPollState } from "../../db/repos/pollStateRepo.js";
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

function tailNewBytes(
  filePath: string,
  lastOffset: number,
  opts: { maxBytes: number }
): { nextOffset: number; text: string } {
  const st = fs.statSync(filePath);
  const size = st.size;
  let start = Math.min(Math.max(lastOffset, 0), size);

  // If this is our first run and the file is huge, only tail the last maxBytes.
  if (start === 0 && size > opts.maxBytes) {
    start = size - opts.maxBytes;
  }

  // If the file was rotated/truncated, reset to 0 (or tail).
  if (start > size) start = 0;

  const len = Math.min(opts.maxBytes, size - start);
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    const read = fs.readSync(fd, buf, 0, len, start);
    return { nextOffset: start + read, text: buf.subarray(0, read).toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

function shouldEmitOnce(db: Db, key: string, value: string) {
  const prev = getPollState(db, key);
  if (prev === value) return false;
  setPollState(db, key, value);
  return true;
}

function resolveScannerLogPath(configPath: string): string | undefined {
  try {
    const st = fs.statSync(configPath);
    if (st.isFile()) return configPath;
    if (!st.isDirectory()) return;

    // Prefer the "active" file if it exists.
    const active = path.join(configPath, "Plex Media Scanner.log");
    if (fs.existsSync(active)) return active;

    // Otherwise, pick the newest rotated file.
    const entries = fs.readdirSync(configPath);
    const candidates = entries
      .filter((n) => n.startsWith("Plex Media Scanner") && n.endsWith(".log") && !n.includes("Analysis"))
      .map((n) => path.join(configPath, n))
      .filter((p) => {
        try {
          return fs.statSync(p).isFile();
        } catch {
          return false;
        }
      });
    if (!candidates.length) return;

    candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    return candidates[0];
  } catch {
    return;
  }
}

function candidatesForPlexAdvance(db: Db, lookbackMs: number): string[] {
  const cutoff = new Date(Date.now() - lookbackMs).toISOString();
  const rows = db
    .prepare(
      `
      select id
      from work_items
      where health = 'ok'
        and stage in ('imported','plex_scanning')
        and updated_at >= ?
      order by updated_at desc
      limit 200
    `
    )
    .all(cutoff) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

export async function pollPlexScanner(db: Db, cfg: AppConfig) {
  const configured = cfg.PLEX_MEDIA_SCANNER_LOG_INGEST_PATH;
  if (!configured) return;

  const logPath = resolveScannerLogPath(configured);
  if (!logPath) return;

  // Offset is tracked per-log-file, since Plex rotates these.
  const offsetKey = `plex:scanner:log_offset_bytes:${logPath}`;
  const lastOffset = Number(getPollState(db, offsetKey) ?? "0");

  const { nextOffset, text } = tailNewBytes(logPath, Number.isFinite(lastOffset) ? lastOffset : 0, { maxBytes: 512_000 });
  if (text.length === 0) {
    markIntegrationOk(db, "plex_scanner");
    return;
  }

  // We correlate scans by Plex "activity" UUID.
  // Start line (example):
  //   Plex Media Scanner --scan --refresh --section 2 --activity <uuid>
  const startRe = /Plex Media Scanner\b.*--scan\b.*--section\s+(\d+)\b.*--activity\s+([0-9a-f-]{8,})/i;

  // Completion line (example):
  //   PUT http://127.0.0.1:32400/activities/<uuid>?percentComplete=100
  const completeRe = /\/activities\/([0-9a-f-]{8,})\?percentComplete=(?:100(?:\.0+)?)/i;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const mStart = line.match(startRe);
    if (mStart) {
      const sectionId = Number(mStart[1]);
      const activityId = mStart[2];
      const fp = `start:${activityId}:${sectionId}`;
      if (!shouldEmitOnce(db, `plex:scanner:dedupe:start:${activityId}`, fp)) continue;

      setPollState(db, `plex:scanner:activity:${activityId}`, JSON.stringify({ sectionId, startedAt: nowIso() }));

      // Heuristic: when we see a scan start, mark recent imported items as plex_scanning.
      for (const id of candidatesForPlexAdvance(db, 2 * 60 * 60 * 1000)) upsertStage(db, id, "plex_scanning");

      // Not correlated to a specific work item yet; emit as integration-level signal.
      markIntegrationOk(db, "plex_scanner");
      continue;
    }

    const mDone = line.match(completeRe);
    if (mDone) {
      const activityId = mDone[1];
      const fp = `done:${activityId}`;
      if (!shouldEmitOnce(db, `plex:scanner:dedupe:done:${activityId}`, fp)) continue;

      const metaRaw = getPollState(db, `plex:scanner:activity:${activityId}`);
      const meta = metaRaw ? (JSON.parse(metaRaw) as { sectionId?: number; startedAt?: string }) : {};

      // Heuristic: on completion, mark recent plex_scanning/imported items as available.
      for (const id of candidatesForPlexAdvance(db, 2 * 60 * 60 * 1000)) upsertStage(db, id, "available");

      // Also attach a synthetic event to those same candidates, so timelines show "why it became available".
      // (We intentionally keep this bounded + deduped to avoid spam.)
      for (const id of candidatesForPlexAdvance(db, 15 * 60 * 1000)) {
        if (!shouldEmitOnce(db, `plex:scanner:dedupe:work_item_done:${id}`, activityId)) continue;
        appendEvent(db, id, {
          ts: nowIso(),
          type: "plex.scan.completed",
          source: "plex",
          severity: "info",
          message: "Plex scan completed",
          data: { activityId, sectionId: meta.sectionId, startedAt: meta.startedAt }
        });
      }

      markIntegrationOk(db, "plex_scanner");
      continue;
    }
  }

  setPollState(db, offsetKey, String(nextOffset));
  markIntegrationOk(db, "plex_scanner");
}

