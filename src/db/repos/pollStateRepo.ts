import type { Db } from "../db.js";

export function getPollState(db: Db, key: string): string | undefined {
  const row = db.prepare("select value from poll_state where key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setPollState(db: Db, key: string, value: string) {
  const now = new Date().toISOString();
  db.prepare(
    `
    insert into poll_state (key, value, updated_at)
    values (?, ?, ?)
    on conflict(key) do update set
      value = excluded.value,
      updated_at = excluded.updated_at
  `
  ).run(key, value, now);
}
