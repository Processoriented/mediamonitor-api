create table if not exists poll_state (
  key text primary key,
  value text not null,
  updated_at text not null
);
