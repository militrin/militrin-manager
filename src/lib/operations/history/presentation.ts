import { addCalendarDays, calendarDateInEventTimeZone } from "./period.ts";
import { EVENT_TIMEZONE, dateTimePartsInEventTimeZone } from "../../utils/date.ts";
import type { HistoryPeriodPreset, OperationHistoryCategory, OperationHistoryItem } from "./types.ts";

export type FeedTone = "success" | "warning" | "danger" | "neutral";
export type FeedIconKind = "kit" | "checkin" | "wristband" | "holder" | "ticket" | "undo" | "store";

export function extraHistoryFilterCount(input: {
  period: HistoryPeriodPreset;
  category: OperationHistoryCategory | "all";
  operatorUserId: string;
}) {
  let count = 0;
  if (input.period !== "today") count += 1;
  if (input.category !== "all") count += 1;
  if (input.operatorUserId) count += 1;
  return count;
}

export function formatFeedClock(value: string | Date, timeZone: string = EVENT_TIMEZONE) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const parts = dateTimePartsInEventTimeZone(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function formatFeedOccurredAt(
  value: string | Date,
  period: HistoryPeriodPreset,
  now: Date = new Date(),
  timeZone: string = EVENT_TIMEZONE,
) {
  const clock = formatFeedClock(value, timeZone);
  if (clock === "—") return clock;
  if (period === "today") return clock;

  const date = value instanceof Date ? value : new Date(value);
  const eventDate = calendarDateInEventTimeZone(date, timeZone);
  const today = calendarDateInEventTimeZone(now, timeZone);
  if (eventDate === today) return `Hoje ${clock}`;
  if (eventDate === addCalendarDays(today, -1)) return `Ontem ${clock}`;
  const [, month, day] = eventDate.split("-");
  return `${day}/${month} ${clock}`;
}

export function feedTone(item: Pick<OperationHistoryItem, "title" | "counts">): FeedTone {
  if (item.counts.correction || /DESFEIT|DESVINCUL|REMOVIDO|BLOQUEADA/.test(item.title)) return "danger";
  if (/ALTERAD|SUBSTITU|CORRIGIDA/.test(item.title)) return "warning";
  if (
    item.counts.kit
    || item.counts.checkin
    || item.counts.wristband
    || item.counts.manualIssue
    || /ENTREGUE|REALIZADO|VINCULADA|EMITIDO|DEFINIDO|CONCEDIDO/.test(item.title)
  ) {
    return "success";
  }
  return "neutral";
}

export function feedIconKind(item: Pick<OperationHistoryItem, "title" | "category" | "counts">): FeedIconKind {
  if (item.counts.correction || /DESFEIT|DESVINCUL|REMOVIDO|BLOQUEADA/.test(item.title)) return "undo";
  if (item.category === "wristbands" || item.counts.wristband) return "wristband";
  if (item.category === "holders") return "holder";
  if (item.category === "tickets" || item.counts.manualIssue) return "ticket";
  if (item.category === "store") return "store";
  if (item.category === "checkin" || (item.counts.checkin && !item.counts.kit)) return "checkin";
  if (item.category === "kit" || item.counts.kit) return "kit";
  return "kit";
}

export function feedParticipantLine(item: Pick<OperationHistoryItem, "participantName" | "stateChanges" | "ticketCode">) {
  if (item.participantName) return item.participantName;
  const titular = item.stateChanges.find((change) => change.label === "Titular");
  if (titular?.next) return titular.next;
  if (titular?.previous) return titular.previous;
  return item.ticketCode ?? "—";
}

export function feedPrimaryInfo(item: Pick<OperationHistoryItem, "shirtLabel" | "wristbandLabel" | "stateChanges" | "title">) {
  if (item.shirtLabel) return item.shirtLabel;
  if (item.wristbandLabel) return item.wristbandLabel;
  const titular = item.stateChanges.find((change) => change.label === "Titular" && change.previous && change.next);
  if (titular && item.title === "TITULAR ALTERADO") return `${titular.previous} → ${titular.next}`;
  return null;
}

export function feedMetaLine(item: Pick<OperationHistoryItem, "ticketCode" | "shirtLabel" | "wristbandLabel" | "stateChanges" | "title" | "operatorName">) {
  return [item.ticketCode, feedPrimaryInfo(item), item.operatorName].filter(Boolean).join(" · ");
}
