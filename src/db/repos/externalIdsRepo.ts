import type { Db } from "../db.js";

export function upsertExternalId(
  db: Db,
  row: { source: string; externalType: string; externalId: string; workItemId: string }
) {
  const now = new Date().toISOString();
  db.prepare(
    `
    insert into external_ids (source, external_type, external_id, work_item_id, created_at, updated_at)
    values (@source, @external_type, @external_id, @work_item_id, @created_at, @updated_at)
    on conflict(source, external_type, external_id) do update set
      work_item_id = excluded.work_item_id,
      updated_at = excluded.updated_at
  `
  ).run({
    source: row.source,
    external_type: row.externalType,
    external_id: row.externalId,
    work_item_id: row.workItemId,
    created_at: now,
    updated_at: now
  });
}

export function findWorkItemIdByExternalId(db: Db, args: { source: string; externalType: string; externalId: string }) {
  const row = db
    .prepare(
      `
      select work_item_id
      from external_ids
      where source = ? and external_type = ? and external_id = ?
    `
    )
    .get(args.source, args.externalType, args.externalId) as { work_item_id: string } | undefined;
  return row?.work_item_id;
}
