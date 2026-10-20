-- Sync-key check with throwaway users; always rolls back. Expected: ERROR "ALL_TESTS_PASSED".
do $$
declare
  orig text := current_user;
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  ka uuid;
  ka2 uuid;
  n int;
  who text;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at) values
    (a, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-a@example.invalid', '{"display_name":"Sync A"}', now(), now()),
    (b, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'sync-b@example.invalid', '{"display_name":"Sync B"}', now(), now());

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select key into ka from public.get_sync_key();
  assert ka is not null, 'no key created';
  assert (select key from public.get_sync_key()) = ka, 'key changes on every call';
  -- a manual value first
  insert into public.daily_stats (day, eaten_kcal) values (current_date, 1500);

  -- B must not see A's key, nor call the sync function
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  select count(*) into n from public.sync_keys where user_id = a;
  assert n = 0, 'B can read A''s key';
  begin
    perform public.apply_health_sync(ka, current_date, 1, 1, 1);
    raise exception 'signed-in user can call apply_health_sync';
  exception when insufficient_privilege then null;
  end;

  -- the function's role applies values; nulls keep the manual value
  perform set_config('role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  who := public.apply_health_sync(ka, current_date, 8432, 486, null);
  assert who = 'Sync A', 'wrong person returned: ' || coalesce(who, 'null');
  assert (select steps from public.daily_stats where user_id = a and day = current_date) = 8432, 'steps not saved';
  assert (select eaten_kcal from public.daily_stats where user_id = a and day = current_date) = 1500, 'manual food value was overwritten';
  assert (select source from public.daily_stats where user_id = a and day = current_date) = 'apple_health', 'source not set';
  who := public.apply_health_sync(ka, current_date, 9100, null, 1650);
  assert (select active_kcal from public.daily_stats where user_id = a and day = current_date) = 486, 'active kcal lost on second sync';
  assert (select steps from public.daily_stats where user_id = a and day = current_date) = 9100, 'second sync did not update steps';
  begin
    perform public.apply_health_sync(gen_random_uuid(), current_date, 1, 1, 1);
    raise exception 'unknown key accepted';
  exception when raise_exception then
    if sqlerrm <> 'invalid_key' then raise; end if;
  end;

  -- A resets the key; the old one stops working
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  ka2 := public.reset_sync_key();
  assert ka2 <> ka, 'reset did not change the key';
  assert (select last_used_at from public.get_sync_key()) is null, 'reset kept last-used time';
  perform set_config('role', 'service_role', true);
  begin
    perform public.apply_health_sync(ka, current_date, 1, 1, 1);
    raise exception 'old key still works after reset';
  exception when raise_exception then
    if sqlerrm <> 'invalid_key' then raise; end if;
  end;

  -- anonymous visitors get nothing
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform public.get_sync_key();
    raise exception 'anonymous visitor can get a key';
  exception when insufficient_privilege then null;
  end;

  perform set_config('role', orig, true);
  raise exception 'ALL_TESTS_PASSED';
end $$;
