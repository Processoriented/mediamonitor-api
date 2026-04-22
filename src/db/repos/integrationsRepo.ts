import type { Db } from "../db.js";

export type IntegrationSyncState = {
  integration: string;
  last_ok_at: string | null;
  last_error_at: string | null;
  last_error_message: string | null;
};

export function markIntegrationOk(db: Db, integration: string) {
  const now = new Date().toISOString();
  db.prepare(
    `
    insert into integration_sync_state (integration, last_ok_at, last_error_at, last_error_message)
    values (?, ?, null, null)
    on conflict(integration) do update set
      last_ok_at = excluded.last_ok_at,
      last_error_at = null,
      last_error_message = null
  `
  ).run(integration, now);
}

export function markIntegrationError(db: Db, integration: string, message: string) {
  const now = new Date().toISOString();
  db.prepare(
    `
    insert into integration_sync_state (integration, last_ok_at, last_error_at, last_error_message)
    values (?, null, ?, ?)
    on conflict(integration) do update set
      last_error_at = excluded.last_error_at,
      last_error_message = excluded.last_error_message
  `
  ).run(integration, now, message.slice(0, 500));
}

