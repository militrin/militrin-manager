-- 047_drop_global_participants_cpf_uniqueness.sql
-- Allow the same CPF to participate in different events and avoid duplicate-key
-- failures when a participant already exists in another event.

begin;

do $$
declare
  v_constraint_name text;
  v_index_name text;
begin
  -- Drop any UNIQUE constraints that include participants.cpf.
  for v_constraint_name in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.participants'::regclass
      and c.contype = 'u'
      and exists (
        select 1
        from unnest(c.conkey) as cols(attnum)
        join pg_attribute a
          on a.attrelid = c.conrelid
         and a.attnum = cols.attnum
        where a.attname = 'cpf'
      )
  loop
    execute format('alter table public.participants drop constraint if exists %I', v_constraint_name);
  end loop;

  -- Drop UNIQUE indexes that enforce CPF uniqueness (when not backed by constraints).
  for v_index_name in
    select idx.relname
    from pg_index i
    join pg_class tbl
      on tbl.oid = i.indrelid
    join pg_namespace ns
      on ns.oid = tbl.relnamespace
    join pg_class idx
      on idx.oid = i.indexrelid
    where ns.nspname = 'public'
      and tbl.relname = 'participants'
      and i.indisunique
      and pg_get_indexdef(i.indexrelid) ilike '%(cpf%'
  loop
    execute format('drop index if exists public.%I', v_index_name);
  end loop;
end
$$;

-- Keep lookup performance for checkout/participant matching.
create index if not exists idx_participants_cpf
  on public.participants (cpf);

create index if not exists idx_participants_event_cpf
  on public.participants (event_id, cpf);

create index if not exists idx_participants_event_cpf_normalized
  on public.participants (
    event_id,
    (regexp_replace(coalesce(cpf, ''), '\\D', '', 'g'))
  );

commit;
