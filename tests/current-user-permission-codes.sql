begin;

create temporary table _perm_map_tests (
  test text primary key,
  codes text[] not null
);

insert into _perm_map_tests(test, codes)
values ('T3_no_jwt', public.current_user_permission_codes());

do $$
declare
  v_participant uuid;
begin
  perform set_config(
    'request.jwt.claims',
    '{"sub":"e8f5777b-3ed1-409d-b3f1-71724be5a09e","role":"authenticated"}',
    true
  );
  insert into _perm_map_tests(test, codes)
  values ('T1_owner', public.current_user_permission_codes());

  insert into _perm_map_tests(test, codes)
  values (
    'T4_nonexistent',
    case when 'this.permission.does.not.exist' = any(public.current_user_permission_codes())
      then array['HAS_FAKE']::text[]
      else array[]::text[]
    end
  );

  select p.user_id into v_participant
  from public.participants p
  where p.user_id is not null
    and not exists (
      select 1 from public.admin_users au
      where au.user_id = p.user_id and au.is_active = true
    )
  limit 1;

  if v_participant is null then
    insert into _perm_map_tests(test, codes) values ('T2_participant', array['NO_CANDIDATE']::text[]);
  else
    perform set_config(
      'request.jwt.claims',
      json_build_object('sub', v_participant::text, 'role', 'authenticated')::text,
      true
    );
    insert into _perm_map_tests(test, codes)
    values ('T2_participant', public.current_user_permission_codes());
  end if;
end
$$;

select test, codes, cardinality(codes) as n
from _perm_map_tests
order by test;

commit;
