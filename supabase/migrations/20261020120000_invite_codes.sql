-- Invite codes that are hard to mistype: no look-alike characters (O/Q/0/D, I/1/L, B/8, S/5,
-- Z/2, G/6, U/V). Joining ignores spaces, dashes, case and the "WD" prefix.

create or replace function public.new_invite_code() returns text
language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ACEFHJKMNPRTWXY34679';
  code text;
begin
  loop
    code := 'WD-';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from groups where invite_code = code);
  end loop;
  return code;
end $$;

-- "wd 7k4-q9x", "WD-7K4Q9X" and "7k4q9x" all become "7K4Q9X"
create or replace function public.normalize_invite_code(raw text) returns text
language sql immutable as $$
  select regexp_replace(regexp_replace(upper(coalesce(raw, '')), '[^A-Z0-9]', '', 'g'), '^WD(?=.{6}$)', '');
$$;

create or replace function public.create_group(group_name text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if char_length(trim(coalesce(group_name, ''))) not between 1 and 40 then raise exception 'invalid_name'; end if;
  insert into groups (name, invite_code, created_by) values (trim(group_name), new_invite_code(), auth.uid()) returning * into g;
  insert into group_members (group_id, user_id) values (g.id, auth.uid());
  return g;
end $$;

create or replace function public.join_group(code text) returns public.groups
language plpgsql security definer set search_path = public as $$
declare
  g public.groups;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  select * into g from groups where normalize_invite_code(invite_code) = normalize_invite_code(code);
  if g.id is null then raise exception 'invalid_code'; end if;
  insert into group_members (group_id, user_id) values (g.id, auth.uid()) on conflict do nothing;
  return g;
end $$;

-- Any member can replace the code, e.g. if the old one was hard to read or shared too widely.
create or replace function public.renew_invite_code(gid uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  code text;
begin
  if auth.uid() is null then raise exception 'not_authenticated'; end if;
  if not is_member(gid) then raise exception 'not_a_member'; end if;
  code := new_invite_code();
  update groups set invite_code = code where id = gid;
  return code;
end $$;

revoke execute on function public.new_invite_code() from public, anon, authenticated;
revoke execute on function public.renew_invite_code(uuid) from public, anon;
grant execute on function public.renew_invite_code(uuid) to authenticated;
grant execute on function public.normalize_invite_code(text) to authenticated;
