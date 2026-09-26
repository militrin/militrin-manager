import { EVENT_TIMEZONE, dateTimePartsInEventTimeZone } from "../../utils/date.ts";
import type { HistoryPeriodPreset } from "./types.ts";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(value: number) {
  return String(value).padStart(2, "0");
}

export function calendarDateInEventTimeZone(date: Date, timeZone: string = EVENT_TIMEZONE) {
  const parts = dateTimePartsInEventTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function addCalendarDays(isoDate: string, days: number) {
  const match = isoDate.match(ISO_DATE);
  if (!match) return isoDate;
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  const shifted = new Date(utc);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

export function isIsoDate(value: string | null | undefined): value is string {
  if (!value || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function resolveHistoryPeriod(input: {
  period: HistoryPeriodPreset;
  dateFrom?: string | null;
  dateTo?: string | null;
  now?: Date;
}) {
  const today = calendarDateInEventTimeZone(input.now ?? new Date());
  if (input.period === "today") return { dateFrom: today, dateTo: today };
  if (input.period === "7d") return { dateFrom: addCalendarDays(today, -6), dateTo: today };
  if (input.period === "30d") return { dateFrom: addCalendarDays(today, -29), dateTo: today };

  const dateFrom = isIsoDate(input.dateFrom) ? input.dateFrom : today;
  const dateTo = isIsoDate(input.dateTo) ? input.dateTo : today;
  if (dateFrom > dateTo) {
    return { dateFrom: dateTo, dateTo: dateFrom };
  }
  return { dateFrom, dateTo };
}

/** Datas de calendário no fuso do evento. Brasil sem DST desde 2019: offset -03:00 estável. */
export function periodToIsoBounds(dateFrom: string, dateTo: string) {
  return {
    fromIso: `${dateFrom}T00:00:00-03:00`,
    toIso: `${dateTo}T23:59:59.999-03:00`,
  };
}

export function formatTimeWithSeconds(value: string | Date, timeZone: string = EVENT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

export function pickDefaultEvent<T extends { id: string; starts_at: string | null; ends_at?: string | null }>(
  events: T[],
  now: Date = new Date(),
) {
  if (!events.length) return null;
  const nowMs = now.getTime();
  const live = events.find((event) => {
    const start = event.starts_at ? Date.parse(event.starts_at) : Number.NaN;
    if (!Number.isFinite(start) || start > nowMs) return false;
    const end = event.ends_at ? Date.parse(event.ends_at) : start + 24 * 60 * 60 * 1000;
    return Number.isFinite(end) && nowMs <= end;
  });
  return live ?? events[0];
}
