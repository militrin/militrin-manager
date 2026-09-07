import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { formatRelativeTimePt } from '../src/lib/notifications/relative-time.ts';
import { mapNotificationRow, notificationTypeLabel } from '../src/lib/notifications/types.ts';

const migrationPath = new URL('../supabase/migrations/20260956000000_organization_notifications.sql', import.meta.url);
const bellPath = new URL('../src/components/dashboard/NotificationBell.tsx', import.meta.url);
const topBarPath = new URL('../src/components/dashboard/TopBar.tsx', import.meta.url);
const pagePath = new URL('../src/app/notificacoes/page.tsx', import.meta.url);
const inboxPath = new URL('../src/app/notificacoes/notifications-inbox.tsx', import.meta.url);
const actionsPath = new URL('../src/app/notificacoes/actions.ts', import.meta.url);
const solicitacoesPath = new URL('../src/app/operacoes/solicitacoes/SolicitacoesClient.tsx', import.meta.url);
const feedbackPath = new URL('../src/app/painel/feedbacks/feedback-manager.tsx', import.meta.url);
const sidebarPath = new URL('../src/components/dashboard/Sidebar.tsx', import.meta.url);
const middlewarePath = new URL('../middleware.ts', import.meta.url);

test('tabela canonica, leituras por usuario, tipos iniciais e idempotencia', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /create table if not exists public\.organization_notifications/);
  assert.match(source, /create table if not exists public\.organization_notification_reads/);
  assert.match(source, /CHANGE_REQUEST_CREATED/);
  assert.match(source, /FEEDBACK_CREATED/);
  assert.match(source, /ux_organization_notifications_org_type_entity/);
  assert.match(source, /on conflict \(organization_id, type, entity_id\) do nothing/);
});

test('RLS e RPCs exigem org + permissao do tipo', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /create or replace function public\.user_can_view_organization_notification/);
  assert.match(source, /kits\.deliver/);
  assert.match(source, /feedback\.view/);
  assert.match(source, /create or replace function public\.list_organization_notifications/);
  assert.match(source, /create or replace function public\.count_unread_organization_notifications/);
  assert.match(source, /create or replace function public\.mark_organization_notification_read/);
  assert.match(source, /create or replace function public\.mark_all_organization_notifications_read/);
  assert.match(source, /raise exception 'Notificacao nao encontrada\.'/ );
});

test('triggers geram notificacao na solicitacao e no feedback', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /trg_notify_ticket_item_change_request_created/);
  assert.match(source, /\/operacoes\/solicitacoes\?requestId=/);
  assert.match(source, /trg_notify_user_feedback_created/);
  assert.match(source, /\/painel\/feedbacks\?feedbackId=/);
  assert.match(source, /Nova solicitação de alteração/);
  assert.match(source, /Novo feedback recebido/);
});

test('realtime usa publication supabase_realtime', async () => {
  const source = await readFile(migrationPath, 'utf8');
  assert.match(source, /alter publication supabase_realtime add table public\.organization_notifications/);
  assert.match(source, /replica identity full/);
});

test('sininho reutiliza o TopBar, tem badge, dropdown e marcar lidas', async () => {
  const bell = await readFile(bellPath, 'utf8');
  const topBar = await readFile(topBarPath, 'utf8');
  const sidebar = await readFile(sidebarPath, 'utf8');
  assert.match(topBar, /<NotificationBell \/>/);
  assert.match(topBar, /hidden lg:inline-flex/);
  assert.doesNotMatch(topBar, /<Bell size=\{18\} \/>/);
  assert.match(bell, /unreadCount/);
  assert.match(bell, /Marcar todas como lidas/);
  assert.match(bell, /Ver todas as notificações/);
  assert.match(bell, /postgres_changes/);
  assert.match(bell, /visibilitychange/);
  assert.match(sidebar, /<NotificationBell compact \/>/);
});

test('pagina /notificacoes filtra lidas, tipo e pagina', async () => {
  const page = await readFile(pagePath, 'utf8');
  const inbox = await readFile(inboxPath, 'utf8');
  const actions = await readFile(actionsPath, 'utf8');
  assert.match(page, /listOrganizationNotificationsAction/);
  assert.match(inbox, /Não lidas/);
  assert.match(inbox, /Solicitações/);
  assert.match(inbox, /Feedbacks/);
  assert.match(inbox, /pagina/);
  assert.match(actions, /mark_organization_notification_read/);
  assert.match(actions, /mark_all_organization_notifications_read/);
});

test('rota /notificacoes exige autenticacao no middleware', async () => {
  const source = await readFile(middlewarePath, 'utf8');
  const protectedList = source.slice(source.indexOf('const protectedPrefixes'), source.indexOf('const requiresAuth'));
  assert.match(protectedList, /'\/notificacoes'/);
});

test('deep-link abre a solicitacao e o feedback correspondentes', async () => {
  const solicitacoes = await readFile(solicitacoesPath, 'utf8');
  const feedback = await readFile(feedbackPath, 'utf8');
  assert.match(solicitacoes, /focusRequestId/);
  assert.match(feedback, /initialFeedbackId/);
});

test('tempo relativo e mapeamento do tipo', () => {
  const now = Date.parse('2026-09-07T18:00:00.000Z');
  assert.equal(formatRelativeTimePt('2026-09-07T17:56:00.000Z', now), 'há 4 min');
  assert.equal(formatRelativeTimePt('2026-09-07T17:42:00.000Z', now), 'há 18 min');
  assert.equal(notificationTypeLabel('CHANGE_REQUEST_CREATED'), 'Solicitações');
  assert.equal(notificationTypeLabel('FEEDBACK_CREATED'), 'Feedbacks');
  const row = mapNotificationRow({
    notification_id: '11111111-1111-4111-8111-111111111111',
    type: 'FEEDBACK_CREATED',
    title: 'Novo feedback recebido',
    body: 'Foi enviado um novo feedback.',
    action_href: '/painel/feedbacks?feedbackId=x',
    created_at: '2026-09-07T18:00:00.000Z',
    is_unread: true,
  });
  assert.equal(row.isUnread, true);
  assert.equal(row.title, 'Novo feedback recebido');
});
