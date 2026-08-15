-- 091_public_event_catalog_rls.sql
-- Restringe o catalogo publico a eventos ativos e com inscricoes abertas,
-- permitindo a mesma consulta para usuarios anonimos e autenticados.

begin;

drop policy if exists "events_select_public" on public.events;
create policy "events_select_public"
  on public.events
  for select
  to anon
  using (
    is_active = true
    and registration_enabled = true
    and (
      coalesce(registration_open_at, registration_open) is null
      or coalesce(registration_open_at, registration_open) <= now()
    )
    and (
      coalesce(registration_close_at, registration_close) is null
      or coalesce(registration_close_at, registration_close) >= now()
    )
  );

drop policy if exists "events_select_public_authenticated" on public.events;
create policy "events_select_public_authenticated"
  on public.events
  for select
  to authenticated
  using (
    is_active = true
    and registration_enabled = true
    and (
      coalesce(registration_open_at, registration_open) is null
      or coalesce(registration_open_at, registration_open) <= now()
    )
    and (
      coalesce(registration_close_at, registration_close) is null
      or coalesce(registration_close_at, registration_close) >= now()
    )
  );

commit;
