import { isTicketDbStatus, parseTicketSituationFilter, type TicketDbStatus, type TicketSituationFilter } from '../tickets/ticket-situation.ts';
import { sanitizeInternalNextPath } from '../utils/safe-navigation.ts';

export const ADMIN_TICKETS_PAGE_SIZE = 50;

export type AdminTicketHolderFilter = 'com' | 'sem' | '';
export type AdminTicketAccountFilter = 'com' | 'sem' | '';
export type AdminTicketCheckinFilter = 'feito' | 'pendente' | '';
export type AdminTicketKitFilter = 'entregue' | 'pendente' | '';
export type AdminTicketPaymentFilter = 'pago' | 'pendente' | 'cancelado' | '';

export type AdminTicketListFilters = {
  evento: string;
  situacao: TicketSituationFilter;
  status: TicketDbStatus | '';
  categoria: string;
  titularidade: AdminTicketHolderFilter;
  conta: AdminTicketAccountFilter;
  checkin: AdminTicketCheckinFilter;
  kit: AdminTicketKitFilter;
  pagamento: AdminTicketPaymentFilter;
  q: string;
  pagina: number;
  userId: string;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

function optionalUuid(value: string) {
  return UUID_PATTERN.test(value) ? value : '';
}

function parseBinary(value: string, allowed: readonly string[]) {
  return allowed.includes(value) ? value : '';
}

export function parseAdminTicketListFilters(
  params: Record<string, string | string[] | undefined>,
): AdminTicketListFilters {
  const statusRaw = one(params.status).trim().toLowerCase();
  const titularidade = parseBinary(one(params.titularidade).trim().toLowerCase(), ['com', 'sem']) as AdminTicketHolderFilter;
  const conta = parseBinary(one(params.conta).trim().toLowerCase(), ['com', 'sem']) as AdminTicketAccountFilter;
  const checkin = parseBinary(one(params.checkin).trim().toLowerCase(), ['feito', 'pendente']) as AdminTicketCheckinFilter;
  const kit = parseBinary(one(params.kit).trim().toLowerCase(), ['entregue', 'pendente']) as AdminTicketKitFilter;
  const pagamento = parseBinary(one(params.pagamento).trim().toLowerCase(), ['pago', 'pendente', 'cancelado']) as AdminTicketPaymentFilter;
  const pagina = Number(one(params.pagina));
  return {
    evento: optionalUuid(one(params.evento).trim()),
    situacao: parseTicketSituationFilter(one(params.situacao)),
    status: isTicketDbStatus(statusRaw) ? statusRaw : '',
    categoria: optionalUuid(one(params.categoria).trim()),
    titularidade,
    conta,
    checkin,
    kit,
    pagamento,
    q: one(params.q).trim(),
    pagina: Number.isInteger(pagina) && pagina > 0 ? pagina : 1,
    userId: optionalUuid(one(params.userId).trim()),
  };
}

export function adminTicketFiltersAreDefault(filters: AdminTicketListFilters) {
  return !filters.evento
    && filters.situacao === 'ativos'
    && !filters.status
    && !filters.categoria
    && !filters.titularidade
    && !filters.conta
    && !filters.checkin
    && !filters.kit
    && !filters.pagamento
    && !filters.q
    && filters.pagina === 1;
}

export function buildAdminTicketsHref(
  filters: Partial<AdminTicketListFilters>,
  extras: { pagina?: number } = {},
) {
  const qs = new URLSearchParams();
  if (filters.evento) qs.set('evento', filters.evento);
  if (filters.situacao && filters.situacao !== 'ativos') qs.set('situacao', filters.situacao);
  if (filters.situacao === 'ativos') qs.set('situacao', 'ativos');
  if (filters.status) qs.set('status', filters.status);
  if (filters.categoria) qs.set('categoria', filters.categoria);
  if (filters.titularidade) qs.set('titularidade', filters.titularidade);
  if (filters.conta) qs.set('conta', filters.conta);
  if (filters.checkin) qs.set('checkin', filters.checkin);
  if (filters.kit) qs.set('kit', filters.kit);
  if (filters.pagamento) qs.set('pagamento', filters.pagamento);
  if (filters.q) qs.set('q', filters.q);
  if (filters.userId) qs.set('userId', filters.userId);
  const pagina = extras.pagina ?? filters.pagina ?? 1;
  if (pagina > 1) qs.set('pagina', String(pagina));
  const encoded = qs.toString();
  return encoded ? `/ingressos?${encoded}` : '/ingressos';
}

export function adminTicketsClearHref(filters: AdminTicketListFilters) {
  return filters.userId ? `/ingressos?userId=${encodeURIComponent(filters.userId)}` : '/ingressos';
}

export function sanitizeAdminTicketsReturnTo(value: string | null | undefined) {
  const safe = sanitizeInternalNextPath(value, '/ingressos');
  if (safe === '/ingressos' || safe.startsWith('/ingressos?')) return safe;
  return '/ingressos';
}

export function adminTicketDetailHref(ticketId: string, listHref: string) {
  const returnTo = listHref && listHref !== '/ingressos'
    ? `?returnTo=${encodeURIComponent(listHref)}`
    : '';
  return `/ingressos/${ticketId}${returnTo}`;
}
