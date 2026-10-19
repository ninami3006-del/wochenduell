-- Access-rule check with three throwaway users. Everything runs in one block that
-- always ends with an exception, so nothing is ever saved.
-- Expected outcome: ERROR "ALL_TESTS_PASSED". Any other error names the failing check.
do $$
declare
  orig text := current_user;
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  g public.groups;
  g2 public.groups;
  n int;
  w uuid;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-a@example.invalid', '{"display_name":"Test A","language":"en"}', now(), now()),
    (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-b@example.invalid', '{"display_name":"Test B"}', now(), now()),
    (c, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'test-c@example.invalid', '{}', now(), now());

  select count(*) into n from public.profiles where id in (a, b, c);
  assert n = 3, 'sign-up trigger created ' || n || ' profiles instead of 3';
  assert (select language from public.profiles where id = a) = 'en', 'language from sign-up not saved';
  assert (select display_name from public.profiles where id = c) = 'test-c', 'fallback name wrong';

  -- A creates a group, logs a workout and daily values
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  g := public.create_group('Testgruppe');
  assert g.invite_code ~ '^WD-[A-HJ-NP-Z2-9]{6}$', 'unexpected invite code ' || g.invite_code;
  insert into public.workouts (day, sport, minutes) values (current_date, 'run', 30) returning id into w;
  insert into public.daily_stats (day, steps) values (current_date, 9000);
  insert into public.daily_stats (day, steps) values (current_date, 9500)
    on conflict (user_id, day) do update set steps = excluded.steps;
  assert (select steps from public.daily_stats where user_id = a and day = current_date) = 9500, 'upsert of own values failed';

  -- B cannot see A before joining, can after
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id = a;
  assert n = 0, 'B sees A before joining';
  g2 := public.join_group(lower(g.invite_code));
  assert g2.id = g.id, 'join with lower-case code failed';
  select count(*) into n from public.profiles where id = a;
  assert n = 1, 'B cannot see A after joining';
  select count(*) into n from public.groups where id = g.id;
  assert n = 1, 'B cannot see the group';
  select count(*) into n from public.group_members where group_id = g.id;
  assert n = 2, 'B sees ' || n || ' members instead of 2';
  select count(*) into n from public.workouts where id = w;
  assert n = 1, 'B cannot see A''s workout';
  select count(*) into n from public.daily_stats where user_id = a;
  assert n = 1, 'B cannot see A''s daily values';
  insert into public.kudos (workout_id) values (w);
  select count(*) into n from public.kudos where workout_id = w;
  assert n = 1, 'kudos not saved';

  begin
    insert into public.workouts (user_id, day, sport, minutes) values (a, current_date, 'run', 30);
    raise exception 'B could add a workout for A';
  exception when insufficient_privilege then null;
  end;
  update public.profiles set display_name = 'hacked' where id = a;
  update public.daily_stats set steps = 1 where user_id = a;

  -- C is an outsider and sees nothing
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id in (a, b);
  assert n = 0, 'outsider sees group members';
  select count(*) into n from public.workouts;
  assert n = 0, 'outsider sees workouts';
  select count(*) into n from public.daily_stats;
  assert n = 0, 'outsider sees daily values';
  select count(*) into n from public.groups;
  assert n = 0, 'outsider sees groups';
  select count(*) into n from public.kudos;
  assert n = 0, 'outsider sees kudos';
  begin
    perform public.join_group('WD-AAAAAA');
    raise exception 'unknown invite code was accepted';
  exception when raise_exception then
    if sqlerrm <> 'invalid_code' then raise; end if;
  end;

  -- anonymous visitors get nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    select count(*) into n from public.profiles;
    raise exception 'anonymous visitor can read profiles';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.create_group('x');
    raise exception 'anonymous visitor can create groups';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', orig, true);
  assert (select display_name from public.profiles where id = a) = 'Test A', 'B could rename A';
  assert (select steps from public.daily_stats where user_id = a and day = current_date) = 9500, 'B could change A''s values';

  raise exception 'ALL_TESTS_PASSED';
end $$;
