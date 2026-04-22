import type { Db } from "../db.js";
import type { Health, Stage, WorkItemType, WorkItemEvent } from "../../domain/types.js";

export type WorkItemRow = {
  id: string;
  type: WorkItemType;
  title: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
  stage: Stage;
  health: Health;
  stalled_since: string | null;
  stall_reason: string | null;
  expected_next_event: string | null;
  created_at: string;
  updated_at: string;
};

export function upsertWorkItem(
  db: Db,
  row: Pick<
    WorkItemRow,
    | "id"
    | "type"
    | "title"
    | "year"
    | "season"
    | "episode"
    | "stage"
    | "health"
    | "stalled_since"
    | "stall_reason"
    | "expected_next_event"
  >
) {
  const now = new Date().toISOString();
  db.prepare(
    `
      insert into work_items (
        id, type, title, year, season, episode,
        stage, health, stalled_since, stall_reason, expected_next_event,
        created_at, updated_at
      ) values (
        @id, @type, @title, @year, @season, @episode,
        @stage, @health, @stalled_since, @stall_reason, @expected_next_event,
        @created_at, @updated_at
      )
      on conflict(id) do update set
        type = excluded.type,
        title = excluded.title,
        year = excluded.year,
        season = excluded.season,
        episode = excluded.episode,
        stage = excluded.stage,
        health = excluded.health,
        stalled_since = excluded.stalled_since,
        stall_reason = excluded.stall_reason,
        expected_next_event = excluded.expected_next_event,
        updated_at = excluded.updated_at
    `
  ).run({
    ...row,
    created_at: now,
    updated_at: now
  });
}

export function appendEvent(db: Db, workItemId: string, e: WorkItemEvent) {
  db.prepare(
    `
    insert into events (work_item_id, ts, type, source, severity, message, data_json)
    values (?, ?, ?, ?, ?, ?, ?)
  `
  ).run(workItemId, e.ts, e.type, e.source, e.severity, e.message ?? null, e.data ? JSON.stringify(e.data) : null);
}

export function listWorkItems(
  db: Db,
  args: { stage?: string; health?: string; type?: string; q?: string; updatedSince?: string }
) {
  const where: string[] = [];
  const params: Record<string, any> = {};

  if (args.stage) {
    where.push("stage = @stage");
    params.stage = args.stage;
  }
  if (args.health) {
    where.push("health = @health");
    params.health = args.health;
  }
  if (args.type) {
    where.push("type = @type");
    params.type = args.type;
  }
  if (args.updatedSince) {
    where.push("updated_at >= @updatedSince");
    params.updatedSince = args.updatedSince;
  }
  if (args.q) {
    where.push("(title like @q)");
    params.q = `%${args.q}%`;
  }

  const sql = `
    select * from work_items
    ${where.length ? `where ${where.join(" and ")}` : ""}
    order by updated_at desc
    limit 200
  `;

  return db.prepare(sql).all(params) as WorkItemRow[];
}

export function getWorkItem(db: Db, id: string) {
  return db.prepare("select * from work_items where id = ?").get(id) as WorkItemRow | undefined;
}

export function getTimeline(db: Db, id: string) {
  return db
    .prepare("select ts, type, source, severity, message, data_json from events where work_item_id = ? order by ts asc, id asc")
    .all(id) as Array<{
    ts: string;
    type: string;
    source: string;
    severity: string;
    message: string | null;
    data_json: string | null;
  }>;
}

