create table if not exists external_ids (
  source text not null,
  external_type text not null,
  external_id text not null,
  work_item_id text not null references work_items(id) on delete cascade,
  created_at text not null,
  updated_at text not null,
  primary key (source, external_type, external_id)
);

create index if not exists idx_external_ids_work_item_id on external_ids(work_item_id);
