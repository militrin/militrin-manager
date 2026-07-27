-- 012_registration_batches_security.sql
-- RLS e permissoes para tabela e funcoes de lotes.

alter table public.registration_batches enable row level security;

drop policy if exists "registration_batches_read_only" on public.registration_batches;
create policy "registration_batches_read_only"
on public.registration_batches
for select
to anon, authenticated
using (true);

revoke insert, update, delete on table public.registration_batches from anon, authenticated;
grant select on table public.registration_batches to anon, authenticated;

revoke all on function public.get_active_registration_batch() from public, anon, authenticated;
revoke all on function public.advance_registration_batch_if_needed(uuid) from public, anon, authenticated;
revoke all on function public.get_registration_batches(uuid) from public, anon, authenticated;
revoke all on function public.create_registration_batch(uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.update_registration_batch(uuid, uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean) from public, anon, authenticated;
revoke all on function public.delete_registration_batch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.activate_registration_batch(uuid, uuid) from public, anon, authenticated;
revoke all on function public.get_registration_pricing_preview(text, text, uuid) from public, anon, authenticated;
revoke all on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_registration_payment(uuid) from public, anon, authenticated;

grant execute on function public.get_active_registration_batch() to anon, authenticated;
grant execute on function public.advance_registration_batch_if_needed(uuid) to anon, authenticated;
grant execute on function public.get_registration_batches(uuid) to anon, authenticated;
grant execute on function public.create_registration_batch(uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean) to anon, authenticated;
grant execute on function public.update_registration_batch(uuid, uuid, text, integer, numeric, numeric, integer, timestamptz, timestamptz, boolean) to anon, authenticated;
grant execute on function public.delete_registration_batch(uuid, uuid) to anon, authenticated;
grant execute on function public.activate_registration_batch(uuid, uuid) to anon, authenticated;
grant execute on function public.get_registration_pricing_preview(text, text, uuid) to anon, authenticated;
grant execute on function public.create_registration(text, text, date, text, text, text, text, text, text, text, text, text, text, uuid, text) to anon, authenticated;
grant execute on function public.confirm_registration_payment(uuid) to anon, authenticated;
