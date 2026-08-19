-- Causa raiz do alerta "Table publicly accessible / rls_disabled_in_public"
-- do Security Advisor: 10 tabelas do schema public NUNCA tiveram
-- ENABLE ROW LEVEL SECURITY em nenhuma migration (confirmado buscando em
-- todo o historico -- a unica ocorrencia dessas tabelas e a criacao delas,
-- em 20260815001914_remote_schema.sql, o dump baseline reconciliado a
-- partir do banco remoto real). Ou seja, o problema ja existia em producao
-- antes deste repositorio de migrations existir; a reconciliacao apenas
-- capturou fielmente esse estado. Todas as 10 tem GRANT ALL (SELECT/
-- INSERT/UPDATE/DELETE) para os roles "anon" e "authenticated" -- o grant
-- default do projeto -- entao, sem RLS, qualquer chamada REST com a anon
-- key (publica, embarcada no bundle do site) le/escreve/apaga linhas
-- diretamente, sem nenhuma checagem de organizacao/permissao. Confirmado
-- empiricamente: teste de SELECT como anon contra o Postgres local
-- retornou array vazio (sem erro de permissao) nas 10 tabelas -- ou seja, a
-- query passou, so nao havia linhas no banco de teste.
--
-- Tabelas: event_addon_options, event_addons_config, event_addons_model,
-- event_batch_addon_options, event_highlights, event_payment_methods,
-- import_batch_rows, import_batches, participation_history,
-- registration_batch_addons. Uma 11a tabela, user_pin_lookup_attempts,
-- tambem esta sem RLS mas so tem grant para service_role (por isso o
-- Security Advisor nem a lista) -- fechada aqui por completude, sem risco
-- de regressao.
--
-- import_batch_rows/import_batches/participation_history guardam PII
-- (nome, CPF, email, telefone de importacoes de participantes). As demais
-- 7 sao configuracao de checkout/evento (addons, formas de pagamento,
-- destaques), sem PII -- risco de integridade/adulteracao, nao de
-- vazamento.
--
-- IMPORTANTE -- limite desta migration: para as 6 tabelas de config
-- (event_addons_config/model/addon_options/batch_addon_options,
-- registration_batch_addons, event_payment_methods), TODA a escrita hoje
-- acontece via RPCs SECURITY DEFINER (upsert_event_addons_config,
-- upsert_event_addon_option, delete_event_addon_option,
-- upsert_event_batch_addon_option, upsert_registration_batch_addons,
-- upsert_event_payment_methods, upsert_event_highlight,
-- remove_event_highlight) que NAO fazem NENHUMA checagem de auth.uid(),
-- permissao ou organizacao no corpo -- ao contrario das RPCs irmas
-- (upsert_event_attraction, upsert_event_schedule_item) que seguem
-- corretamente o padrao current_user_has_permission('events.edit') +
-- user_can_access_organization. Como essas funcoes rodam OWNER TO postgres
-- e nenhuma tabela do schema usa FORCE ROW LEVEL SECURITY (adicionar FORCE
-- quebraria TODAS as RPCs SECURITY DEFINER do projeto, nao so estas),
-- RLS nas tabelas NAO bloqueia essas RPCs -- so fecha o acesso direto via
-- API REST (PostgREST), que e exatamente o vetor do alerta reportado.
-- upsert_registration_batch_addons tambem tem EXECUTE concedido a "anon"
-- (sem uso legitimo encontrado no app), o que a torna chamavel por
-- visitante nao autenticado. Esse gap de autorizacao dentro das RPCs e um
-- achado separado, documentado no relatorio final desta auditoria e
-- deliberadamente NAO corrigido nesta migration (ver instrucao de nao
-- expandir automaticamente o escopo da correcao) -- requer decisao
-- explicita sobre corrigir as 7 funcoes.
--
-- Para as outras 4 tabelas (import_batches, import_batch_rows,
-- participation_history, event_highlights), a escrita legitima hoje
-- acontece via Server Actions Next.js (src/app/importacoes/actions.ts,
-- src/app/eventos/actions.ts) usando o client de SESSAO do usuario
-- (createServerSupabaseClient, role authenticated) com .from(...) direto
-- -- ou seja, RLS bem desenhada aqui E o mecanismo de autorizacao real,
-- nao so defesa em profundidade. As policies abaixo replicam o contrato de
-- acesso ja implicito no codigo hoje (levantado auditando cada call site em
-- src/), usando os mesmos helpers ja usados em todo o resto do schema
-- (user_can_access_organization, current_user_has_permission,
-- is_platform_owner) -- sem inventar nenhum modelo de autorizacao novo.
begin;

-- ─────────────────────────────────────────────────────────────────────────
-- import_batches (sem organization_id -- so event_id nullable e
-- imported_by; historical_participations pode nao ter evento associado)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.import_batches enable row level security;

create policy "import_batches_select" on public.import_batches
  for select to authenticated
  using (
    public.is_platform_owner(auth.uid())
    or imported_by = auth.uid()
    or (
      public.current_user_has_permission('imports.view')
      and (
        event_id is null
        or public.user_can_access_organization(auth.uid(), (select e.organization_id from public.events e where e.id = import_batches.event_id))
      )
    )
  );

create policy "import_batches_insert" on public.import_batches
  for insert to authenticated
  with check (
    public.is_platform_owner(auth.uid())
    or (
      imported_by = auth.uid()
      and (
        event_id is null
        or public.user_can_access_organization(auth.uid(), (select e.organization_id from public.events e where e.id = import_batches.event_id))
      )
    )
  );

create policy "import_batches_update" on public.import_batches
  for update to authenticated
  using (public.is_platform_owner(auth.uid()) or imported_by = auth.uid())
  with check (public.is_platform_owner(auth.uid()) or imported_by = auth.uid());

-- ─────────────────────────────────────────────────────────────────────────
-- import_batch_rows (sem organization_id proprio -- deriva de
-- import_batches via import_batch_id)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.import_batch_rows enable row level security;

create policy "import_batch_rows_select" on public.import_batch_rows
  for select to authenticated
  using (
    exists (
      select 1 from public.import_batches b
      where b.id = import_batch_rows.import_batch_id
        and (
          public.is_platform_owner(auth.uid())
          or b.imported_by = auth.uid()
          or (
            public.current_user_has_permission('imports.view')
            and (
              b.event_id is null
              or public.user_can_access_organization(auth.uid(), (select e.organization_id from public.events e where e.id = b.event_id))
            )
          )
        )
    )
  );

create policy "import_batch_rows_insert" on public.import_batch_rows
  for insert to authenticated
  with check (
    exists (
      select 1 from public.import_batches b
      where b.id = import_batch_rows.import_batch_id
        and (public.is_platform_owner(auth.uid()) or b.imported_by = auth.uid())
    )
  );

create policy "import_batch_rows_update" on public.import_batch_rows
  for update to authenticated
  using (
    exists (
      select 1 from public.import_batches b
      where b.id = import_batch_rows.import_batch_id
        and (public.is_platform_owner(auth.uid()) or b.imported_by = auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.import_batches b
      where b.id = import_batch_rows.import_batch_id
        and (public.is_platform_owner(auth.uid()) or b.imported_by = auth.uid())
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- participation_history (sem organization_id -- so event_id nullable;
-- dois contratos coexistindo: dono le o proprio historico em
-- /minha-conta/historico via user_id=auth.uid(), e staff com
-- participants.view/finance.confirm_payment/imports.view le/escreve via
-- paineis e fluxo de importacao)
-- ─────────────────────────────────────────────────────────────────────────
alter table public.participation_history enable row level security;

create policy "participation_history_select" on public.participation_history
  for select to authenticated
  using (
    user_id = auth.uid()
    or public.is_platform_owner(auth.uid())
    or (
      (
        public.current_user_has_permission('participants.view')
        or public.current_user_has_permission('finance.confirm_payment')
        or public.current_user_has_permission('imports.view')
      )
      and (
        event_id is null
        or public.user_can_access_organization(auth.uid(), (select e.organization_id from public.events e where e.id = participation_history.event_id))
      )
    )
  );

create policy "participation_history_insert" on public.participation_history
  for insert to authenticated
  with check (
    public.is_platform_owner(auth.uid())
    or (
      import_batch_id is not null
      and exists (
        select 1 from public.import_batches b
        where b.id = participation_history.import_batch_id
          and b.imported_by = auth.uid()
      )
    )
  );

-- ─────────────────────────────────────────────────────────────────────────
-- event_highlights e as 6 tabelas de configuracao de evento/checkout: sem
-- PII, ja expostas publicamente em JSON pelas RPCs get_event_addons_setup/
-- get_event_addons_dynamic_setup/get_event_payment_methods_setup para o
-- fluxo publico de inscricao -- leitura publica nao piora a exposicao
-- atual e segue o mesmo padrao ja usado em tabelas irmas
-- (event_kit_items_read_only, event_attractions_read_only,
-- registration_batch_prices_read_only). Escrita: NENHUMA policy -- fica
-- restrita a service_role, fechando o acesso direto via API REST. Isso NAO
-- bloqueia as RPCs SECURITY DEFINER hoje sem checagem propria (ver nota no
-- topo do arquivo).
-- ─────────────────────────────────────────────────────────────────────────
alter table public.event_highlights enable row level security;
create policy "event_highlights_read_only" on public.event_highlights
  for select to authenticated, anon using (true);

alter table public.event_addons_config enable row level security;
create policy "event_addons_config_read_only" on public.event_addons_config
  for select to authenticated, anon using (true);

alter table public.event_addons_model enable row level security;
create policy "event_addons_model_read_only" on public.event_addons_model
  for select to authenticated, anon using (true);

alter table public.event_addon_options enable row level security;
create policy "event_addon_options_read_only" on public.event_addon_options
  for select to authenticated, anon using (true);

alter table public.event_batch_addon_options enable row level security;
create policy "event_batch_addon_options_read_only" on public.event_batch_addon_options
  for select to authenticated, anon using (true);

alter table public.registration_batch_addons enable row level security;
create policy "registration_batch_addons_read_only" on public.registration_batch_addons
  for select to authenticated, anon using (true);

alter table public.event_payment_methods enable row level security;
create policy "event_payment_methods_read_only" on public.event_payment_methods
  for select to authenticated, anon using (true);

-- ─────────────────────────────────────────────────────────────────────────
-- user_pin_lookup_attempts: ja sem grant para anon/authenticated (so
-- service_role), portanto ja nao explorável via API -- fechado aqui so por
-- completude/consistencia com o restante do schema, sem nenhuma policy
-- (service_role sempre ignora RLS; nada mais tem grant pra usar mesmo).
-- ─────────────────────────────────────────────────────────────────────────
alter table public.user_pin_lookup_attempts enable row level security;

commit;
