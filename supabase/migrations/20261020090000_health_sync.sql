-- Apple Health sync: every person gets a secret sync key. The iPhone Shortcut sends today's
-- values together with that key to the health-sync function, which calls apply_health_sync.

create table public.sync_keys (
  user_id uuid primary key references auth.users on delete cascade,
  key uuid not null unique default gen_random_uuid(),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
alter table public.sync_keys enable row level security;
create policy "sync_keys: read own" on public.sync_keys
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.sync_keys from anon;

-- Own key for the app (created on first use)
create or replace function public.get_sync_key() returns table (key uuid, last_used_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  insert into sync_keys (user_id) values (auth.uid()) on conflict (user_id) do nothing;
  return query select s.key, s.last_used_at from sync_keys s where s.user_id = auth.uid();
end $$;

-- New key, e.g. if the old link was shared by mistake
create or replace function public.reset_sync_key() returns uuid
language plpgsql security definer set search_path = public as $$
declare k uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  insert into sync_keys (user_id) values (auth.uid())
    on conflict (user_id) do update set key = gen_random_uuid(), last_used_at = null
    returning sync_keys.key into k;
  return k;
end $$;

-- Only the health-sync function (service role) may call this.
-- Empty or zero values keep what is already saved for the day.
create or replace function public.apply_health_sync(p_key uuid, p_day date, p_steps int, p_active int, p_eaten int)
returns text
language plpgsql security definer set search_path = public as $$
declare uid uuid;
begin
  select user_id into uid from sync_keys where key = p_key;
  if uid is null then raise exception 'invalid_key'; end if;
  update sync_keys set last_used_at = now() where user_id = uid;
  insert into daily_stats (user_id, day, steps, active_kcal, eaten_kcal, source)
  values (uid, p_day, p_steps, p_active, p_eaten, 'apple_health')
  on conflict (user_id, day) do update set
    steps = coalesce(excluded.steps, daily_stats.steps),
    active_kcal = coalesce(excluded.active_kcal, daily_stats.active_kcal),
    eaten_kcal = coalesce(excluded.eaten_kcal, daily_stats.eaten_kcal),
    source = 'apple_health';
  return (select display_name from profiles where id = uid);
end $$;

revoke execute on function public.get_sync_key(), public.reset_sync_key() from public, anon;
grant execute on function public.get_sync_key(), public.reset_sync_key() to authenticated;
revoke execute on function public.apply_health_sync(uuid, date, int, int, int) from public, anon, authenticated;
grant execute on function public.apply_health_sync(uuid, date, int, int, int) to service_role;
