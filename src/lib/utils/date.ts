const BR_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number) {
  return String(value).padStart(2, '0');
}

// Fuso canônico dos eventos brasileiros atuais. Nunca compensar com +3h/-3h:
// gravar datetime-local como parede neste fuso e exibir com Intl neste fuso.
export const EVENT_TIMEZONE = 'America/Sao_Paulo';

const DATETIME_LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;

export function parseDateInput(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  const text = value.trim();
  if (!text) return null;

  const brMatch = text.match(BR_DATE_REGEX);
  if (brMatch) {
    const day = Number(brMatch[1]);
    const month = Number(brMatch[2]);
    const year = Number(brMatch[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  // Um DATE do Postgres ("YYYY-MM-DD", sem hora) representa uma data de
  // calendário, não um instante no tempo -- new Date(text) interpretaria
  // esse formato como meia-noite UTC, e as leituras locais (getDate() etc.)
  // abaixo devolveriam o dia anterior em qualquer timezone atrás de UTC
  // (todo o Brasil). Construir com o mesmo padrão local do ramo BR acima
  // preserva o dia de calendário independentemente do fuso da máquina.
  // Timestamps reais (com T/hora/offset) NÃO batem nesse regex e continuam
  // caindo no new Date(text) abaixo, preservando a semântica de instante.
  const isoDateOnlyMatch = text.match(ISO_DATE_ONLY_REGEX);
  if (isoDateOnlyMatch) {
    const year = Number(isoDateOnlyMatch[1]);
    const month = Number(isoDateOnlyMatch[2]);
    const day = Number(isoDateOnlyMatch[3]);
    const date = new Date(year, month - 1, day);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return null;
    }
    return date;
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function dateTimePartsInEventTimeZone(date: Date, timeZone: string = EVENT_TIMEZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return {
    day: map.day ?? '',
    month: map.month ?? '',
    year: map.year ?? '',
    hour: pad(Number(map.hour || 0)),
    minute: pad(Number(map.minute || 0)),
  };
}

function isCalendarDateOnly(value: string) {
  const text = value.trim();
  return ISO_DATE_ONLY_REGEX.test(text) || BR_DATE_REGEX.test(text);
}

function formatHourParts(hour: string, minute: string) {
  return Number(minute) ? `${hour}h${minute}` : `${hour}h`;
}

/** Faixa compacta da Home: "10 OUT · 13h–19h30", sempre em America/Sao_Paulo. */
export function formatCompactEventWhen(startsAt: string | Date | null | undefined, endsAt: string | Date | null | undefined): string | null {
  const start = parseDateInput(startsAt);
  if (!start) return null;
  const startParts = dateTimePartsInEventTimeZone(start);
  const month = new Intl.DateTimeFormat('pt-BR', {
    timeZone: EVENT_TIMEZONE,
    month: 'short',
  }).format(start).replace('.', '').toUpperCase();
  const day = Number(startParts.day);
  const startHour = formatHourParts(startParts.hour, startParts.minute);
  const end = parseDateInput(endsAt);
  if (!end) return `${day} ${month} · ${startHour}`;
  const endParts = dateTimePartsInEventTimeZone(end);
  return `${day} ${month} · ${startHour}–${formatHourParts(endParts.hour, endParts.minute)}`;
}

export function formatDateBR(value: string | Date | null | undefined) {
  const parts = calendarPartsInEventTimeZone(value);
  if (!parts) return '-';
  return `${pad(parts.day)}/${pad(parts.month)}/${parts.year}`;
}

export function formatDateTimeBR(value: string | Date | null | undefined, connector = ' ') {
  if (typeof value === 'string' && isCalendarDateOnly(value)) {
    return `${formatDateBR(value)}${connector}00:00`;
  }
  const date = parseDateInput(value);
  if (!date) return '-';
  const parts = dateTimePartsInEventTimeZone(date);
  return `${parts.day}/${parts.month}/${parts.year}${connector}${parts.hour}:${parts.minute}`;
}

export function formatDateTimeCompactBR(value: string | Date | null | undefined) {
  if (typeof value === 'string' && isCalendarDateOnly(value)) {
    const parts = calendarPartsFromDateOnly(value);
    if (!parts) return '—';
    return `${pad(parts.day)}/${pad(parts.month)}/${String(parts.year).slice(-2)} 00:00`;
  }
  const date = parseDateInput(value);
  if (!date) return '—';
  const parts = dateTimePartsInEventTimeZone(date);
  return `${parts.day}/${parts.month}/${parts.year.slice(-2)} ${parts.hour}:${parts.minute}`;
}

export function formatStackedDateTimeBR(
  value: string | Date | null | undefined,
  options?: { now?: Date; todayLabel?: boolean },
) {
  const date = parseDateInput(value);
  if (!date) return { line1: '—', line2: null as string | null, title: '—', isToday: false };
  const parts = dateTimePartsInEventTimeZone(date);
  const dateLine = `${parts.day}/${parts.month}/${parts.year.slice(-2)}`;
  const timeLine = `${parts.hour}:${parts.minute}`;
  const title = `${parts.day}/${parts.month}/${parts.year} ${timeLine}`;
  const nowParts = dateTimePartsInEventTimeZone(options?.now ?? new Date());
  const isToday = parts.year === nowParts.year && parts.month === nowParts.month && parts.day === nowParts.day;
  return {
    line1: options?.todayLabel && isToday ? 'Hoje' : dateLine,
    line2: timeLine,
    title,
    isToday,
  };
}

export function formatDateLongBR(value: string | Date | null | undefined) {
  const date = parseDateInput(value);
  if (!date) return '-';
  if (typeof value === 'string' && isCalendarDateOnly(value)) {
    return new Intl.DateTimeFormat('pt-BR', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(date);
  }
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: EVENT_TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

export function formatBirthDateBRInput(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

export const maskDateBR = formatBirthDateBRInput;

export function isValidBRDate(value: string) {
  return parseDateInput(value) !== null && BR_DATE_REGEX.test(value.trim());
}

export const isValidDateBR = isValidBRDate;

export function toISODateFromBR(value: string) {
  const date = parseDateInput(value);
  if (!date) return null;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const parseDateBRToISO = toISODateFromBR;

export function formatISOToDateBR(value: string | null | undefined) {
  if (!value) return '';
  return formatDateBR(value) === '-' ? '' : formatDateBR(value);
}

// birth_date e sempre date-only (sem hora, sem timezone) -- extrai
// ano/mes/dia via parseDateInput (que ja constroi e le com getters locais
// do mesmo processo, logo o dia de calendario nunca muda com o fuso) em vez
// de qualquer conversao de instante.
function calendarPartsFromDateOnly(value: string | Date | null | undefined): { year: number; month: number; day: number } | null {
  const date = parseDateInput(value);
  if (!date) return null;
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}

// starts_at normalmente e um instante real (timestamp with time zone) -- o
// "dia do evento" e o dia de calendario que esse instante representa no
// fuso do evento, nunca o fuso de quem esta rodando o codigo. Mas se o
// valor recebido já é uma data de calendário pura (YYYY-MM-DD ou
// DD/MM/YYYY, sem hora/offset -- ex.: um teste ou um caller que só tem a
// data), NÃO faz sentido reinterpretá-la como instante e convertê-la de
// novo para o fuso do evento: isso aplicaria timezone duas vezes e poderia
// mudar o dia dependendo de onde o processo roda. Nesse caso ela já É o
// dia do evento, então só lemos ano/mês/dia diretamente, igual ao
// nascimento.
function calendarPartsInEventTimeZone(value: string | Date | null | undefined): { year: number; month: number; day: number } | null {
  if (typeof value === 'string') {
    const text = value.trim();
    if (ISO_DATE_ONLY_REGEX.test(text) || BR_DATE_REGEX.test(text)) {
      return calendarPartsFromDateOnly(text);
    }
  }

  const date = parseDateInput(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  if (!year || !month || !day) return null;
  return { year, month, day };
}

// Idade abaixo disso, na data de referência, é dado cadastral implausível
// para um perfil de inscrito (ex.: DOB com ano = ano do evento). Não é
// evidência de menor real e não deve ser usada como regra de maioridade.
export const MIN_PLAUSIBLE_PERSON_AGE_YEARS = 5;

export function isPlausiblePersonAge(ageYears: number | null | undefined) {
  return ageYears != null && ageYears >= MIN_PLAUSIBLE_PERSON_AGE_YEARS;
}

// Fonte canônica única de idade-na-data-do-evento (contact-first: consumida
// tanto pelo checkout público quanto pelas importações -- ver
// src/app/inscricao/actions.ts e src/app/importacoes/actions.ts). Retorna
// null quando os dados são insuficientes para decidir (nunca inventa uma
// idade) -- cabe a quem chama tratar esse caso explicitamente.
export function calculateAgeAtEventDate(
  birthDate: string | Date | null | undefined,
  eventStartsAt: string | Date | null | undefined,
): number | null {
  const birth = calendarPartsFromDateOnly(birthDate);
  const event = calendarPartsInEventTimeZone(eventStartsAt);
  if (!birth || !event) return null;

  const birthIsAfterEvent = birth.year > event.year
    || (birth.year === event.year && birth.month > event.month)
    || (birth.year === event.year && birth.month === event.month && birth.day > event.day);
  if (birthIsAfterEvent) return null;

  let age = event.year - birth.year;
  const beforeBirthdayThisYear = event.month < birth.month || (event.month === birth.month && event.day < birth.day);
  if (beforeBirthdayThisYear) age -= 1;
  return age;
}

// true/false = decisão definitiva; null = não foi possível decidir (evento
// sem starts_at válido, ou nascimento inválido) -- o chamador deve tratar
// esse terceiro estado explicitamente, nunca assumir "permitido" por padrão.
export function isMinimumAgeSatisfied(
  birthDate: string | Date | null | undefined,
  eventStartsAt: string | Date | null | undefined,
  minAge: number | null | undefined,
): boolean | null {
  if (!minAge || minAge <= 0) return true;
  const age = calculateAgeAtEventDate(birthDate, eventStartsAt);
  if (age === null) return null;
  return age >= minAge;
}

export function toDatetimeLocalValue(value: string | Date | null | undefined) {
  const date = parseDateInput(value);
  if (!date) return '';
  if (typeof value === 'string' && isCalendarDateOnly(value)) {
    const parts = calendarPartsFromDateOnly(value);
    if (!parts) return '';
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T00:00`;
  }
  const parts = dateTimePartsInEventTimeZone(date);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/**
 * Interpreta um valor de <input type="datetime-local"> (parede, sem offset)
 * como horário no fuso do evento e devolve o instante ISO. Instants já
 * gravados (com Z ou ±HH:MM) passam direto -- nunca aplica offset fixo.
 */
export function datetimeLocalInEventTimeZoneToIso(value: string, timeZone: string = EVENT_TIMEZONE): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/[zZ]$/.test(trimmed) || /[+-]\d{2}:\d{2}$/.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const match = trimmed.match(DATETIME_LOCAL_RE);
  if (!match) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? 0);
  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utcMs = desiredAsUtc;

  for (let i = 0; i < 3; i += 1) {
    const parts = dateTimePartsInEventTimeZone(new Date(utcMs), timeZone);
    const gotAsUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      second,
    );
    const diff = desiredAsUtc - gotAsUtc;
    if (diff === 0) break;
    utcMs += diff;
  }

  return new Date(utcMs).toISOString();
}
