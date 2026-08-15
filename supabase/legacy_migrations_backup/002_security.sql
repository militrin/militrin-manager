alter table public.participants enable row level security;
alter table public.payments enable row level security;
alter table public.shirt_inventory enable row level security;
alter table public.kit_deliveries enable row level security;
alter table public.audit_logs enable row level security;

drop policy if exists "Authenticated users can read participants" on public.participants;
create policy "Authenticated users can read participants"
on public.participants
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert participants" on public.participants;
create policy "Authenticated users can insert participants"
on public.participants
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update participants" on public.participants;
create policy "Authenticated users can update participants"
on public.participants
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete participants" on public.participants;
create policy "Authenticated users can delete participants"
on public.participants
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read payments" on public.payments;
create policy "Authenticated users can read payments"
on public.payments
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert payments" on public.payments;
create policy "Authenticated users can insert payments"
on public.payments
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update payments" on public.payments;
create policy "Authenticated users can update payments"
on public.payments
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete payments" on public.payments;
create policy "Authenticated users can delete payments"
on public.payments
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can read shirt inventory"
on public.shirt_inventory
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can insert shirt inventory"
on public.shirt_inventory
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can update shirt inventory"
on public.shirt_inventory
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete shirt inventory" on public.shirt_inventory;
create policy "Authenticated users can delete shirt inventory"
on public.shirt_inventory
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can read kit deliveries"
on public.kit_deliveries
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can insert kit deliveries"
on public.kit_deliveries
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can update kit deliveries"
on public.kit_deliveries
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete kit deliveries" on public.kit_deliveries;
create policy "Authenticated users can delete kit deliveries"
on public.kit_deliveries
for delete to authenticated using (true);

drop policy if exists "Authenticated users can read audit logs" on public.audit_logs;
create policy "Authenticated users can read audit logs"
on public.audit_logs
for select to authenticated using (true);

drop policy if exists "Authenticated users can insert audit logs" on public.audit_logs;
create policy "Authenticated users can insert audit logs"
on public.audit_logs
for insert to authenticated with check (true);

drop policy if exists "Authenticated users can update audit logs" on public.audit_logs;
create policy "Authenticated users can update audit logs"
on public.audit_logs
for update to authenticated using (true) with check (true);

drop policy if exists "Authenticated users can delete audit logs" on public.audit_logs;
create policy "Authenticated users can delete audit logs"
on public.audit_logs
for delete to authenticated using (true);
