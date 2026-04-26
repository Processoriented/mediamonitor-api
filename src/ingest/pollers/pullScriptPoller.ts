import fs from "node:fs";
import { createHash } from "node:crypto";
import type { Db } from "../../db/db.js";
import type { AppConfig } from "../../config.js";
import { appendEvent, getWorkItem, upsertWorkItem } from "../../db/repos/workItemsRepo.js";
import { findWorkItemIdByExternalId } from "../../db/repos/externalIdsRepo.js";
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

function setFailed(db: Db, workItemId: string, reason: string) {
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

function parseDownloadId(line: string): string | undefined {
  const m = line.match(/\[(SABnzbd_nzo_[^\]]+)\]/);
  return m?.[1];
}

function fingerprint(parts: Array<string | number | undefined | null>) {
  const s = parts.filter((p) => p !== undefined && p !== null).join("|");
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

function shouldEmitOnce(db: Db, key: string, fp: string) {
  const prev = getPollState(db, key);
  if (prev === fp) return false;
  setPollState(db, key, fp);
  return true;
}

function inferWorkItemId(db: Db, downloadId: string): string | undefined {
  return findWorkItemIdByExternalId(db, { source: "sabnzbd", externalType: "download_id", externalId: downloadId });
}

function tailNewBytes(
  filePath: string,
  lastOffset: number,
  opts: { maxBytes: number }
): { nextOffset: number; text: string; usedStartOffset: number } {
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
    return { nextOffset: start + read, usedStartOffset: start, text: buf.subarray(0, read).toString("utf8") };
  } finally {
    fs.closeSync(fd);
  }
}

export async function pollPullScript(db: Db, cfg: AppConfig) {
  const logPath = cfg.SABNZBD_PULL_LOG_INGEST_PATH;
  const statePath = cfg.SABNZBD_PULL_STATE_INGEST_PATH;

  if (!fs.existsSync(logPath) || !fs.existsSync(statePath)) return;

  const offsetKey = "pullscript:log_offset_bytes";
  const lastOffset = Number(getPollState(db, offsetKey) ?? "0");

  const { nextOffset, text } = tailNewBytes(logPath, Number.isFinite(lastOffset) ? lastOffset : 0, { maxBytes: 512_000 });
  if (text.length === 0) {
    markIntegrationOk(db, "pullscript");
    return;
  }

  let currentDownloadId: string | undefined;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) continue;

    const dl = parseDownloadId(line);
    if (dl) currentDownloadId = dl;
    if (!currentDownloadId) continue;

    const workItemId = inferWorkItemId(db, currentDownloadId);
    if (!workItemId) continue;

    // Move stage to pulling whenever we see pull-script activity.
    upsertStage(db, workItemId, "pulling");

    if (line.includes("INFO Processing")) {
      const fp = fingerprint(["processing", currentDownloadId, line]);
      if (!shouldEmitOnce(db, `pullscript:dedupe:${workItemId}:processing`, fp)) continue;
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: "pull.processing",
        source: "pullscript",
        severity: "info",
        message: "Pull processing item",
        data: { downloadId: currentDownloadId, line }
      });
      continue;
    }

    if (line.includes("INFO rclone copy:")) {
      const fp = fingerprint(["copy_started", currentDownloadId, line]);
      if (!shouldEmitOnce(db, `pullscript:dedupe:${workItemId}:copy_started`, fp)) continue;
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: "pull.rclone.copy_started",
        source: "pullscript",
        severity: "info",
        message: "rclone copy started",
        data: { downloadId: currentDownloadId, line }
      });
      continue;
    }

    if (line.includes("ERROR rclone copy failed")) {
      const fp = fingerprint(["copy_failed", currentDownloadId, line]);
      if (!shouldEmitOnce(db, `pullscript:dedupe:${workItemId}:copy_failed`, fp)) continue;
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: "pull.rclone.copy_failed",
        source: "pullscript",
        severity: "error",
        message: "rclone copy failed",
        data: { downloadId: currentDownloadId, line }
      });
      setFailed(db, workItemId, "pull.rclone.copy_failed");
      continue;
    }

    if (line.includes("rclone check")) {
      const fp = fingerprint(["check", currentDownloadId, line]);
      if (!shouldEmitOnce(db, `pullscript:dedupe:${workItemId}:check`, fp)) continue;
      appendEvent(db, workItemId, {
        ts: nowIso(),
        type: "pull.rclone.check",
        source: "pullscript",
        severity: "info",
        message: "rclone check",
        data: { downloadId: currentDownloadId, line }
      });
      continue;
    }
  }

  // Persist offset after successful parse.
  setPollState(db, offsetKey, String(nextOffset));

  // State file snapshot (lightweight; future: correlate by processed list deltas)
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const processedCount = Array.isArray(parsed?.processed) ? parsed.processed.length : undefined;
    // Not correlated to a specific work item yet; we only expose it via /integrations for now.
  } catch {
    // ignore
  }

  markIntegrationOk(db, "pullscript");
}

