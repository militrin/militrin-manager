const BR_DATE_REGEX = /^(\d{2})\/(\d{2})\/(\d{4})$/;

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

export function calculateAgeFromDateBR(value: string) {
  const date = parseDateInput(value);
  if (!date || !isValidBRDate(value)) return 0;

  const today = new Date();
  let age = today.getFullYear() - date.getFullYear();
  const monthDiff = today.getMonth() - date.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < date.getDate())) {
    age -= 1;
  }
  return age;
}

export function toDatetimeLocalValue(value: string | Date | null | undefined) {
  const date = parseDateInput(value);
  if (!date) return '';
  const tzOffset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - tzOffset).toISOString().slice(0, 16);
}
