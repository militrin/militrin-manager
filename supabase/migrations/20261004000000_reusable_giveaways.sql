begin;

alter table public.giveaways
  add column if not exists name text,
  add column if not exists description text,
  add column if not exists instagram_media_type text,
  add column if not exists instagram_thumbnail_url text,
  add column if not exists instagram_published_at timestamptz;

alter table public.giveaways drop constraint if exists giveaways_status_check;
alter table public.giveaways add constraint giveaways_status_check check (status in (
  'empty',
  'draft',
  'preparing',
  'ready',
  'drawing',
  'running',
  'awaiting_validation',
  'finalized',
  'completed',
  'cancelled'
));

-- Metadados apenas. Nao altera status, winner, snapshot, entries ou historico.
alter table public.giveaways disable trigger giveaways_protect_frozen_source;

update public.giveaways
set name = case
  when public_id = 'MILITRIN-2026-0831-006' then coalesce(nullif(btrim(name), ''), 'Sorteio oficial')
  else coalesce(nullif(btrim(name), ''), public_id)
end
where name is null or btrim(name) = '';

update public.giveaways
set instagram_media_permalink = 'https://www.instagram.com/p/Dcb8sKsJ91b/'
where public_id = 'MILITRIN-2026-0831-006'
  and instagram_media_permalink is null;

alter table public.giveaways enable trigger giveaways_protect_frozen_source;

alter table public.giveaways
  alter column name set default '',
  alter column name set not null;

create or replace function public.protect_frozen_giveaway_source()
returns trigger language plpgsql set search_path to 'public', 'pg_temp' as $$
begin
  if old.snapshot_frozen_at is not null and (
    new.organization_id is distinct from old.organization_id or
    new.source is distinct from old.source or
    new.public_id is distinct from old.public_id or
    new.source_file_name is distinct from old.source_file_name or
    new.instagram_integration_id is distinct from old.instagram_integration_id or
    new.instagram_media_id is distinct from old.instagram_media_id or
    new.instagram_media_permalink is distinct from old.instagram_media_permalink or
    new.instagram_media_caption is distinct from old.instagram_media_caption or
    new.instagram_media_type is distinct from old.instagram_media_type or
    new.instagram_thumbnail_url is distinct from old.instagram_thumbnail_url or
    new.instagram_published_at is distinct from old.instagram_published_at or
    new.imported_at is distinct from old.imported_at or
    new.synced_at is distinct from old.synced_at or
    new.snapshot_frozen_at is distinct from old.snapshot_frozen_at
  ) then
    raise exception 'Snapshot congelado: origem e publicacao sao imutaveis.';
  end if;
  return new;
end;
$$;

commit;
