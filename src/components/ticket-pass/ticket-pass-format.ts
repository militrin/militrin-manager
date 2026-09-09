import { parseDateInput } from '../../lib/utils/date.ts';
import { orderDisplayReference } from '../../lib/display-reference.ts';
import { getStatusLabel } from '../../lib/status-labels.ts';
import { OKTOBERFEST_ACCESS_NOTICE } from '../../lib/public/oktoberfest-access-notice.ts';

const EVENT_TIMEZONE = 'America/Sao_Paulo';
const MONTHS_PT = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN', 'JUL', 'AGO', 'SET', 'OUT', 'NOV', 'DEZ'] as const;
const ISO_DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const BR_DATE_REGEX = /^\d{2}\/\d{2}\/\d{4}$/;
const NAIVE_ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

export type EventPassDateParts = {
  day: string;
  month: string;
  year: string;
  time: string | null;
};

function isDateOnly(value: string) {
  const text = value.trim();
  return ISO_DATE_ONLY_REGEX.test(text) || BR_DATE_REGEX.test(text);
}

export function formatEventPassDate(value: string | Date | null | undefined): EventPassDateParts | null {
  if (value == null || value === '') return null;

  if (typeof value === 'string' && isDateOnly(value)) {
    const date = parseDateInput(value);
    if (!date) return null;
    return {
      day: String(date.getDate()),
      month: MONTHS_PT[date.getMonth()],
      year: String(date.getFullYear()),
      time: null,
    };
  }

  const instant = typeof value === 'string' && NAIVE_ISO_DATETIME_REGEX.test(value.trim())
    ? `${value.trim()}Z`
    : value;
  const date = parseDateInput(instant);
  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EVENT_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const dayRaw = parts.find((part) => part.type === 'day')?.value;
  const monthRaw = Number(parts.find((part) => part.type === 'month')?.value);
  const year = parts.find((part) => part.type === 'year')?.value;
  let hour = parts.find((part) => part.type === 'hour')?.value;
  const minute = parts.find((part) => part.type === 'minute')?.value;
  if (!dayRaw || !monthRaw || !year || hour == null || minute == null) return null;

  if (hour === '24') hour = '00';

  return {
    day: String(Number(dayRaw)),
    month: MONTHS_PT[monthRaw - 1],
    year,
    time: `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`,
  };
}

export function formatEventPassOrderNumber(value: string | null | undefined) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed || trimmed === 'sem número') return null;
  if (trimmed.startsWith('#')) return trimmed;
  const formatted = orderDisplayReference(null, trimmed);
  return formatted === 'sem número' ? null : formatted;
}

export const TICKET_PASS_COPY = {
  eyebrow: 'Acesso Militrin',
  holderLabel: 'Titular',
  categoryLabel: 'Categoria',
  orderLabel: 'Pedido',
  statusLabel: 'Status',
  activeStatus: 'ATIVO',
  qrPurpose: 'QR para retirada do kit',
  qrInstructionLine1: 'Apresente este QR Code',
  qrInstructionLine2: 'no ponto de retirada do Militrin',
  oktoberfestNoticeTitle: OKTOBERFEST_ACCESS_NOTICE.title,
  oktoberfestNoticeBody: OKTOBERFEST_ACCESS_NOTICE.short,
  footerLine1: 'Amizade • Tradição • Boas escolhas',
  footerLine2: 'Beba com moderação',
  downloadPdf: 'Baixar PDF',
  downloadImage: 'Baixar imagem',
  generatingPdf: 'Gerando PDF...',
  generatingImage: 'Gerando imagem...',
  qrImageAlt: 'QR Code para retirada do kit Militrin',
} as const;

export type TicketPassViewModelInput = {
  eventName: string;
  participantName?: string | null;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
  orderNumber?: string | null;
};

export type TicketPassViewModel = {
  eventName: string;
  categoryName: string | null;
  holderName: string | null;
  orderNumber: string | null;
  status: string;
  statusText: string;
  statusIsActive: boolean;
  dateParts: EventPassDateParts | null;
  location: string | null;
  token: string;
};

export function ticketPassStatusPresentation(status: string) {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'active') {
    return { text: TICKET_PASS_COPY.activeStatus, isActive: true };
  }
  return { text: getStatusLabel(status), isActive: false };
}

export function buildTicketPassViewModel(input: TicketPassViewModelInput): TicketPassViewModel {
  const holder = String(input.participantName ?? '').trim() || null;
  const category = String(input.categoryName ?? '').trim() || null;
  const location = String(input.eventLocation ?? '').trim() || null;
  const status = ticketPassStatusPresentation(input.status);
  return {
    eventName: String(input.eventName ?? '').trim() || 'Evento',
    categoryName: category,
    holderName: holder,
    orderNumber: formatEventPassOrderNumber(input.orderNumber),
    status: String(input.status ?? ''),
    statusText: status.text,
    statusIsActive: status.isActive,
    dateParts: formatEventPassDate(input.eventDate),
    location,
    token: String(input.token ?? '').trim(),
  };
}

export function ticketPassExportFileStem(model: Pick<TicketPassViewModel, 'orderNumber' | 'eventName'>) {
  const order = model.orderNumber?.replace(/^#/, '') ?? '';
  if (order) return `acesso-militrin-${order}`;
  const slug = model.eventName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug ? `acesso-militrin-${slug}` : 'acesso-militrin';
}
