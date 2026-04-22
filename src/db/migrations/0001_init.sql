create table if not exists integration_sync_state (
  integration text primary key,
  last_ok_at text,
  last_error_at text,
  last_error_message text
);

create table if not exists work_items (
  id text primary key,
  type text not null check (type in ('movie','episode')),
  title text,
  year integer,
  season integer,
  episode integer,

  stage text not null,
  health text not null,
  stalled_since text,
  stall_reason text,
  expected_next_event text,

  created_at text not null,
  updated_at text not null
);

create table if not exists events (
  id integer primary key autoincrement,
  work_item_id text not null references work_items(id) on delete cascade,
  ts text not null,
  type text not null,
  source text not null,
  severity text not null,
  message text,
  data_json text
);

create index if not exists idx_events_work_item_id_ts on events(work_item_id, ts);

