const BR_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const ISO_DATE_ONLY_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number) {
  return String(value).padStart(2, '0');
}

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

export function formatDateBR(value: string | Date | null | undefined) {
  const date = parseDateInput(value);
  if (!date) return '-';
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`;
}

export function formatDateTimeBR(value: string | Date | null | undefined, connector = ' ') {
  const date = parseDateInput(value);
  if (!date) return '-';
  return `${formatDateBR(date)}${connector}${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateLongBR(value: string | Date | null | undefined) {
  const date = parseDateInput(value);
  if (!date) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
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

// Fuso fixo do evento -- o Militrin so opera eventos no Brasil, entao o
// "dia do evento" e sempre o dia de calendario em America/Sao_Paulo,
// independentemente de onde o processo (servidor, CI, maquina do dev) esta
// rodando. Sem isso, um starts_at perto da meia-noite UTC poderia cair num
// dia diferente dependendo se quem le e um servidor em UTC ou um navegador
// no Brasil -- exatamente o tipo de dependencia de timezone que a regra de
// maioridade nao pode ter.
const EVENT_TIMEZONE = 'America/Sao_Paulo';

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
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}
