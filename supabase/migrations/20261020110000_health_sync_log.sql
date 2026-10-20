-- Raw values as the iPhone Shortcut sent them (no key), to see why a value arrives empty.
-- Only the health-sync function (service role) writes here; nobody can read it from the app.
create table public.health_sync_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  at timestamptz not null default now(),
  raw jsonb not null
);
alter table public.health_sync_log enable row level security;
revoke all on public.health_sync_log from anon, authenticated;
