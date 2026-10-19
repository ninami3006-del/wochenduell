-- Wochenduell: profiles, groups with invite codes, daily values, workouts, kudos.
-- Everyone sees only the people they share a group with (row level security).

-- ---------- tables ----------
create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 30),
  calorie_goal int not null default 2000 check (calorie_goal between 1000 and 5000),
  language text not null default 'de' check (language in ('de', 'en')),
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  invite_code text not null unique,
  created_by uuid not null references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index group_members_user_idx on public.group_members (user_id);

create table public.daily_stats (
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  day date not null,
  steps int check (steps between 0 and 200000),
  active_kcal int check (active_kcal between 0 and 20000),
  eaten_kcal int check (eaten_kcal between 0 and 20000),
  source text not null default 'manual' check (char_length(source) <= 30),
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table public.workouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  day date not null,
  started_at timestamptz not null default now(),
  sport text not null check (char_length(sport) between 1 and 30),
  minutes int not null check (minutes between 1 and 600),
  source text not null default 'manual' check (char_length(source) <= 30),
  created_at timestamptz not null default now()
);
create index workouts_user_day_idx on public.workouts (user_id, day);

create table public.kudos (
  workout_id uuid not null references public.workouts on delete cascade,
  user_id uuid not null references auth.users on delete cascade default auth.uid(),
  created_at timestamptz not null default now(),
  primary key (workout_id, user_id)
);

-- ---------- helpers (security definer so policies don't recurse) ----------
create or replace function public.is_member(gid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from group_members where group_id = gid and user_id = auth.uid());
$$;

create or replace function public.shares_group(other uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from group_members a
    join group_members b on a.group_id = b.group_id
    where a.user_id = auth.uid() and b.user_id = other
  );
$$;

-- new sign-up -> profile (name and language come from the sign-up form)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name, language)
  values (
    new.id,
    left(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'Sportler'), 30),
    case when new.raw_user_meta_data ->> 'language' in ('de', 'en') then new.raw_user_meta_data ->> 'language' else 'de' end
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger daily_stats_touch before update on public.daily_stats
  for each row execute function public.touch_updated_at();

-- ---------- group actions ----------
create or replace function public.create_group(group_name text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
  code text;
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if char_length(trim(coalesce(group_name, ''))) not between 1 and 40 then raise exception 'invalid_name'; end if;
  loop
    code := 'WD-';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from groups where invite_code = code);
  end loop;
  insert into groups (name, invite_code, created_by) values (trim(group_name), code, auth.uid()) returning * into g;
  insert into group_members (group_id, user_id) values (g.id, auth.uid());
  return g;
end $$;

create or replace function public.join_group(code text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into g from groups where invite_code = upper(trim(code));
  if g.id is null then raise exception 'invalid_code'; end if;
  insert into group_members (group_id, user_id) values (g.id, auth.uid()) on conflict do nothing;
  return g;
end $$;

-- ---------- row level security ----------
alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.daily_stats enable row level security;
alter table public.workouts enable row level security;
alter table public.kudos enable row level security;

create policy "profiles: self and group mates can read" on public.profiles
  for select to authenticated using (id = (select auth.uid()) or public.shares_group(id));
create policy "profiles: edit own" on public.profiles
  for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy "groups: members can read" on public.groups
  for select to authenticated using (public.is_member(id));
create policy "groups: creator can rename" on public.groups
  for update to authenticated using (created_by = (select auth.uid())) with check (created_by = (select auth.uid()));

create policy "group_members: members can read" on public.group_members
  for select to authenticated using (public.is_member(group_id));
create policy "group_members: leave own" on public.group_members
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "daily_stats: self and group mates can read" on public.daily_stats
  for select to authenticated using (user_id = (select auth.uid()) or public.shares_group(user_id));
create policy "daily_stats: add own" on public.daily_stats
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "daily_stats: edit own" on public.daily_stats
  for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "daily_stats: delete own" on public.daily_stats
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "workouts: self and group mates can read" on public.workouts
  for select to authenticated using (user_id = (select auth.uid()) or public.shares_group(user_id));
create policy "workouts: add own" on public.workouts
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "workouts: delete own" on public.workouts
  for delete to authenticated using (user_id = (select auth.uid()));

create policy "kudos: readable with the workout" on public.kudos
  for select to authenticated using (
    exists (select 1 from public.workouts w where w.id = workout_id
            and (w.user_id = (select auth.uid()) or public.shares_group(w.user_id))));
create policy "kudos: give own" on public.kudos
  for insert to authenticated with check (
    user_id = (select auth.uid())
    and exists (select 1 from public.workouts w where w.id = workout_id
                and (w.user_id = (select auth.uid()) or public.shares_group(w.user_id))));
create policy "kudos: take back own" on public.kudos
  for delete to authenticated using (user_id = (select auth.uid()));

-- ---------- privileges: nothing for anonymous visitors ----------
revoke all on public.profiles, public.groups, public.group_members, public.daily_stats, public.workouts, public.kudos from anon;
revoke execute on function public.create_group(text), public.join_group(text), public.is_member(uuid), public.shares_group(uuid) from public, anon;
grant execute on function public.create_group(text), public.join_group(text), public.is_member(uuid), public.shares_group(uuid) to authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
