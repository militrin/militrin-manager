-- Completa 20261110: a RPC grava resolution=textual_holder e
-- review_decision=import_as_textual_holder, mas os CHECKs de
-- import_batch_rows ainda nao aceitavam esses valores.
-- Sem DELETE, sem limpeza dos 29, sem ownership.

begin;

alter table public.import_batch_rows drop constraint if exists import_batch_rows_resolution_check;
alter table public.import_batch_rows add constraint import_batch_rows_resolution_check
  check (resolution = any (array[
    'pending','link_existing','create_new','ignore','mark_duplicate','textual_holder'
  ]));

alter table public.import_batch_rows drop constraint if exists import_batch_rows_review_decision_check;
alter table public.import_batch_rows add constraint import_batch_rows_review_decision_check
  check (
    review_decision is null
    or review_decision = any (array[
      'link_existing','create_new','ignore','confirm_new_purchase','ignore_technical_duplicate',
      'confirm_excel_cpf','keep_pending_cpf','provide_alternate_cpf','assign_owner_contact',
      'keep_people_separate','keep_shared_contact_email','provide_own_email','import_as_textual_holder'
    ])
  );

comment on constraint import_batch_rows_resolution_check on public.import_batch_rows is
  'Inclui textual_holder: titular adicional sem Cadastro permanente.';

commit;
