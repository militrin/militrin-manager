/*
==================================================

PLANEJAMENTO - NAO EXECUTAR.
PLANEJAMENTO — NÃO EXECUTAR.

ADMIN ROLES + PERMISSIONS BLUEPRINT

Este arquivo NAO e uma migration.

Objetivo:

Planejar uma arquitetura hibrida de controle de acesso
administrativo baseada em:
- funcoes/cargos;
- permissoes individuais;
- excecoes por usuario (allow/deny).

Status:
PLANEJAMENTO

Nao executar.

==================================================
*/

-- Blueprint only: DO NOT APPLY in this sprint.
-- Escopo desta etapa:
-- 1) Definir modelo de dados futuro.
-- 2) Definir catalogo inicial de permissoes.
-- 3) Definir funcoes padrao e regras de resolucao.
-- 4) Definir checklist de integracao gradual (UI + server + DB).
--
-- Fora de escopo agora:
-- - criar migration executavel;
-- - alterar fluxos publicos;
-- - acoplar novas telas em booleano unico is_admin.

-- ==================================================
-- 1) MODELO DE DADOS FUTURO
-- ==================================================

create table if not exists public.admin_roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  is_system boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  description text,
  module text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.admin_role_permissions (
  role_id uuid not null references public.admin_roles(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (role_id, permission_id)
);

create table if not exists public.admin_users (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role_id uuid references public.admin_roles(id) on delete set null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_user_permission_overrides (
  user_id uuid not null references auth.users(id) on delete cascade,
  permission_id uuid not null references public.admin_permissions(id) on delete cascade,
  effect text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, permission_id),
  constraint admin_user_permission_overrides_effect_check check (effect in ('allow', 'deny'))
);

create index if not exists idx_admin_permissions_module on public.admin_permissions(module, code);
create index if not exists idx_admin_users_role_active on public.admin_users(role_id, is_active);
create index if not exists idx_admin_overrides_user on public.admin_user_permission_overrides(user_id, effect);

-- ==================================================
-- 2) CATALOGO INICIAL DE PERMISSOES
-- ==================================================
-- Observacao:
-- Este bloco define a fonte de verdade desejada para codigos.
-- Em migration futura, usar upsert por code.

insert into public.admin_permissions (code, name, description, module)
values
  ('dashboard.view', 'Ver dashboard', 'Visualiza indicadores gerais', 'dashboard'),

  ('participants.view', 'Ver participantes', 'Visualiza listagem de participantes', 'participants'),
  ('participants.create', 'Criar participante', 'Cria inscricoes/participantes', 'participants'),
  ('participants.edit_basic', 'Editar dados basicos', 'Altera dados nao sensiveis', 'participants'),
  ('participants.edit_sensitive', 'Editar dados sensiveis', 'Altera cpf/email e dados criticos', 'participants'),
  ('participants.cancel', 'Cancelar participante', 'Cancela inscricao/participante', 'participants'),
  ('participants.export', 'Exportar participantes', 'Exporta planilhas e relatrios', 'participants'),

  ('inventory.view', 'Ver estoque', 'Consulta saldo e disponibilidade', 'inventory'),
  ('inventory.add_order', 'Adicionar encomenda', 'Registra encomendas/entradas de estoque', 'inventory'),
  ('inventory.adjust', 'Ajustar estoque', 'Ajusta quantidades e corrige divergencias', 'inventory'),
  ('inventory.change_participant_shirt', 'Alterar camiseta do participante', 'Troca tamanho/tipo de camiseta do inscrito', 'inventory'),
  ('inventory.view_history', 'Ver historico de estoque', 'Visualiza movimentacoes e historico', 'inventory'),

  ('kits.view', 'Ver kits', 'Consulta status de retirada/entrega', 'kits'),
  ('kits.deliver', 'Entregar kit', 'Registra entrega de kit/itens', 'kits'),
  ('kits.undo_delivery', 'Desfazer entrega', 'Reverte entrega registrada', 'kits'),
  ('kits.replace_item', 'Substituir item', 'Substitui item entregue', 'kits'),
  ('kits.view_history', 'Ver historico de kits', 'Visualiza historico de retiradas e alteracoes', 'kits'),

  ('checkin.view', 'Ver check-in', 'Consulta status de check-in', 'checkin'),
  ('checkin.scan', 'Realizar check-in', 'Autoriza leitura/confirmacao de entrada', 'checkin'),
  ('checkin.undo', 'Desfazer check-in', 'Reverte entrada confirmada', 'checkin'),
  ('checkin.view_history', 'Ver historico de check-in', 'Visualiza historico de entrada', 'checkin'),

  ('finance.view', 'Ver financeiro', 'Acessa modulo financeiro', 'finance'),
  ('finance.view_amounts', 'Ver valores', 'Visualiza valores, totais e detalhamento monetario', 'finance'),
  ('finance.confirm_payment', 'Confirmar pagamento', 'Confirma pagamento manual quando permitido', 'finance'),
  ('finance.refund', 'Estornar pagamento', 'Executa estornos autorizados', 'finance'),
  ('finance.export', 'Exportar financeiro', 'Exporta relatrios financeiros', 'finance'),
  ('finance.manage_fees', 'Gerenciar taxas', 'Configura/ajusta taxas operacionais', 'finance'),

  ('events.view', 'Ver eventos', 'Consulta configuracoes e eventos', 'events'),
  ('events.create', 'Criar eventos', 'Cria novos eventos', 'events'),
  ('events.edit', 'Editar eventos', 'Edita configuracoes de eventos', 'events'),
  ('events.publish', 'Publicar eventos', 'Publica/abre evento para publico', 'events'),
  ('events.archive', 'Arquivar eventos', 'Arquiva ou desativa eventos', 'events'),

  ('batches.view', 'Ver lotes', 'Consulta lotes de inscricao', 'batches'),
  ('batches.create', 'Criar lotes', 'Cria lotes de venda', 'batches'),
  ('batches.edit', 'Editar lotes', 'Edita parametros de lotes', 'batches'),
  ('batches.activate', 'Ativar lotes', 'Ativa/abre lotes para venda', 'batches'),
  ('batches.delete', 'Excluir lotes', 'Remove lotes quando permitido', 'batches'),

  ('categories.view', 'Ver categorias', 'Consulta categorias de ingresso', 'categories'),
  ('categories.create', 'Criar categorias', 'Cria categorias', 'categories'),
  ('categories.edit', 'Editar categorias', 'Edita categorias', 'categories'),
  ('categories.delete', 'Excluir categorias', 'Remove categorias', 'categories'),

  ('coupons.view', 'Ver cupons', 'Consulta cupons cadastrados', 'coupons'),
  ('coupons.create', 'Criar cupons', 'Cria cupons promocionais', 'coupons'),
  ('coupons.edit', 'Editar cupons', 'Edita regras de cupons', 'coupons'),
  ('coupons.disable', 'Desabilitar cupons', 'Desativa cupons', 'coupons'),
  ('coupons.view_usage', 'Ver uso de cupons', 'Consulta uso e consumo de cupons', 'coupons'),

  ('photos.view_admin', 'Ver fotos no admin', 'Acessa area administrativa de fotos', 'photos'),
  ('photos.upload', 'Upload de fotos', 'Envia fotos para albuns', 'photos'),
  ('photos.publish', 'Publicar fotos', 'Publica fotos/albuns para publico', 'photos'),
  ('photos.delete', 'Excluir fotos', 'Remove fotos/albuns', 'photos'),

  ('team.view', 'Ver equipe', 'Visualiza equipe administrativa', 'team'),
  ('team.invite', 'Convidar equipe', 'Convida novos membros administrativos', 'team'),
  ('team.edit_permissions', 'Editar permissoes da equipe', 'Altera funcao e overrides de usuarios', 'team'),
  ('team.disable_user', 'Desativar usuario da equipe', 'Revoga acesso administrativo do usuario', 'team'),
  ('audit.view', 'Ver auditoria', 'Visualiza trilha de auditoria', 'security'),
  ('settings.manage', 'Gerenciar configuracoes', 'Acessa configuracoes administrativas criticas', 'settings')
on conflict (code) do nothing;

-- ==================================================
-- 3) FUNCOES PADRAO (ROLES) E PERFIS INICIAIS
-- ==================================================
-- Roles sugeridas:
-- - OWNER
-- - ADMIN
-- - MANAGER
-- - FINANCEIRO
-- - CHECK-IN
-- - ENTREGA DE KIT
-- - ESTOQUE
-- - SUPORTE
-- - VISUALIZACAO

insert into public.admin_roles (name, description, is_system)
values
  ('OWNER', 'Acesso total. Papel sistemico, nao removivel por admin comum.', true),
  ('ADMIN', 'Acesso amplo com restricoes de governanca definidas pelo sistema.', true),
  ('MANAGER', 'Operacao de eventos, participantes, lotes, estoque e relatorios operacionais.', true),
  ('FINANCEIRO', 'Pagamentos, estornos, taxas e relatorios financeiros.', true),
  ('CHECK-IN', 'Scanner e controle de entrada sem acesso financeiro.', true),
  ('ENTREGA DE KIT', 'Consulta participante e entrega de kit sem acesso tecnico amplo.', true),
  ('ESTOQUE', 'Gestao de estoque e troca de camiseta sem acesso financeiro.', true),
  ('SUPORTE', 'Correcao de cadastro e suporte sem operacoes financeiras criticas.', true),
  ('VISUALIZACAO', 'Somente leitura dos modulos liberados.', true)
on conflict (name) do nothing;

-- Mapeamento role->permission (resumo de intencao, definir em migration futura):
-- OWNER: todas as permissoes.
-- ADMIN: quase todas, com bloqueio de acoes criticas sobre OWNER e configuracoes blindadas.
-- MANAGER: dashboard/view, participants/* (exceto edit_sensitive opcional), events.*, batches.*, categories.*, inventory.view, inventory.view_history, coupons.view, coupons.view_usage.
-- FINANCEIRO: finance.*, dashboard.view, participants.view, participants.export.
-- CHECK-IN: checkin.*, participants.view, dashboard.view.
-- ENTREGA DE KIT: kits.view, kits.deliver, kits.view_history, participants.view.
-- ESTOQUE: inventory.*, participants.view, kits.view.
-- SUPORTE: participants.view, participants.edit_basic, participants.edit_sensitive (opcional com governanca), kits.view, checkin.view.
-- VISUALIZACAO: dashboard.view + *.view permitidos por politica.

-- ==================================================
-- 4) OVERRIDES POR USUARIO (ALLOW/DENY)
-- ==================================================
-- Casos de uso esperados:
-- 1) Usuario de ENTREGA DE KIT com allow em inventory.change_participant_shirt.
-- 2) Usuario MANAGER com deny em finance.view_amounts.
--
-- Regra: override e sempre por permissao individual e por usuario.

-- ==================================================
-- 5) RESOLUCAO DE PERMISSAO (FUTURO HELPER)
-- ==================================================
-- API alvo:
-- public.user_has_permission(p_user_id uuid, p_permission_code text) returns boolean
--
-- Prioridade:
-- 1) usuario inativo -> negar
-- 2) override deny -> negar
-- 3) override allow -> permitir
-- 4) permissao da funcao -> permitir
-- 5) caso contrario -> negar
--
-- Regra OWNER:
-- - se usuario ativo com role OWNER: acesso total por regra explicita.

-- Exemplo de esqueleto (nao executar agora):
-- create or replace function public.user_has_permission(
--   p_user_id uuid,
--   p_permission_code text
-- ) returns boolean
-- language plpgsql
-- security definer
-- set search_path = public, pg_temp
-- as $$
-- declare
--   v_is_active boolean;
--   v_role_name text;
-- begin
--   select au.is_active, ar.name
--     into v_is_active, v_role_name
--   from public.admin_users au
--   left join public.admin_roles ar on ar.id = au.role_id
--   where au.user_id = p_user_id;
--
--   if coalesce(v_is_active, false) = false then
--     return false;
--   end if;
--
--   if v_role_name = 'OWNER' then
--     return true;
--   end if;
--
--   if exists (
--     select 1
--     from public.admin_user_permission_overrides uo
--     join public.admin_permissions ap on ap.id = uo.permission_id
--     where uo.user_id = p_user_id
--       and ap.code = p_permission_code
--       and uo.effect = 'deny'
--   ) then
--     return false;
--   end if;
--
--   if exists (
--     select 1
--     from public.admin_user_permission_overrides uo
--     join public.admin_permissions ap on ap.id = uo.permission_id
--     where uo.user_id = p_user_id
--       and ap.code = p_permission_code
--       and uo.effect = 'allow'
--   ) then
--     return true;
--   end if;
--
--   return exists (
--     select 1
--     from public.admin_users au
--     join public.admin_role_permissions arp on arp.role_id = au.role_id
--     join public.admin_permissions ap on ap.id = arp.permission_id
--     where au.user_id = p_user_id
--       and ap.code = p_permission_code
--   );
-- end;
-- $$;

-- ==================================================
-- 6) REGRAS DE SEGURANCA OBRIGATORIAS
-- ==================================================
-- 1) Ocultar menu sem permissao.
-- 2) Bloquear tambem no servidor e no banco.
-- 3) Nunca confiar apenas no menu oculto.
-- 4) Toda RPC de escrita deve validar permissao.
-- 5) RLS ou SECURITY DEFINER devem validar usuario autenticado.
-- 6) Nunca usar service_role no navegador.

-- ==================================================
-- 7) UX ADMIN FUTURA
-- ==================================================
-- Rota sugerida: /configuracoes/equipe
--
-- Listagem:
-- - nome
-- - e-mail
-- - funcao
-- - status
-- - ultimo acesso
-- - acoes
--
-- Edicao de usuario:
-- - selecionar funcao
-- - visualizar permissoes herdadas por modulo
-- - adicionar/remover overrides
-- - ativar/desativar acesso
-- - observacao interna

-- Experiencia recomendada:
-- 1) escolher funcao pronta
-- 2) visualizar permissoes herdadas
-- 3) aplicar overrides pontuais

-- ==================================================
-- 8) AUDITORIA (FUTURA)
-- ==================================================
-- Toda acao critica deve ser auditada com:
-- - actor_user_id
-- - target_user_id
-- - acao
-- - detalhes anteriores/novos
-- - motivo (quando aplicavel)
-- - timestamp
--
-- Eventos criticos:
-- - convite
-- - alteracao de funcao
-- - add/remove override
-- - desativacao de acesso
-- - alteracoes financeiras
-- - estorno
-- - cancelamento
-- - troca de camiseta
-- - desfazer entrega

-- Tabela sugerida (futura):
-- public.admin_audit_logs (
--   id uuid pk,
--   actor_user_id uuid,
--   target_user_id uuid,
--   action text,
--   reason text,
--   before_data jsonb,
--   after_data jsonb,
--   created_at timestamptz
-- )

-- ==================================================
-- 9) SESSAO E CONSISTENCIA
-- ==================================================
-- Requisito: alteracoes de permissao devem valer na proxima requisicao.
-- Nao depender de token antigo por horas.
--
-- Diretriz:
-- - backend consulta estado atual (admin_users + role + overrides)
--   ou usa cache curto com invalidacao imediata por versao.

-- ==================================================
-- 10) ESTRATEGIA DE ADOCAO GRADUAL
-- ==================================================
-- Fase 1:
-- - Criar migration de tabelas base (admin_roles, admin_permissions, ...).
-- - Popular catalogo de permissoes.
-- - Criar roles padrao.
--
-- Fase 2:
-- - Criar public.user_has_permission.
-- - Introduzir helper no backend para gates de servidor.
-- - Introduzir wrappers por modulo (requirePermission).
--
-- Fase 3:
-- - Ajustar RPCs de escrita para validar permissao.
-- - Revisar RLS/SECURITY DEFINER para enforcement.
--
-- Fase 4:
-- - Criar UI /configuracoes/equipe.
-- - Conectar tela de listagem/edicao com auditoria.
--
-- Fase 5:
-- - Remover dependencias de booleano unico is_admin em telas novas.
-- - Padronizar visibilidade de menu por permissao.

-- ==================================================
-- 11) CRITERIOS DE ACEITE PARA ESTA ETAPA
-- ==================================================
-- [x] Blueprint criado em supabase/plans.
-- [x] Cabecalho explicito de planejamento e nao execucao.
-- [x] Lista inicial de permissoes documentada.
-- [x] Roles padrao documentadas.
-- [x] Regras de resolucao/seguranca/auditoria documentadas.
-- [x] Nenhuma migration executavel criada nesta sprint.
-- [x] Nenhuma alteracao no fluxo publico.
