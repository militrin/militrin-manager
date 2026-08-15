-- 046_fix_tickets_participant_nullable_runtime.sql
-- Ensure unassigned order items can issue tickets with participant_id = null.
-- This is required for repeat purchases where the new ticket is not auto-assigned.

begin;

alter table if exists public.tickets
  alter column participant_id drop not null;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'tickets_participant_id_fkey'
      and conrelid = 'public.tickets'::regclass
  ) then
    alter table public.tickets
      drop constraint tickets_participant_id_fkey;
  end if;

  alter table public.tickets
    add constraint tickets_participant_id_fkey
    foreign key (participant_id)
    references public.participants(id)
    on delete set null;
end
$$;

create index if not exists idx_tickets_participant_id
  on public.tickets (participant_id);

commit;
