import { addCalendarDays, calendarDateInEventTimeZone } from "./period.ts";
import { EVENT_TIMEZONE, dateTimePartsInEventTimeZone } from "../../utils/date.ts";
import type { HistoryPeriodPreset, OperationHistoryCategory, OperationHistoryItem } from "./types.ts";

export type FeedTone = "success" | "warning" | "danger" | "neutral";
export type FeedIconKind = "kit" | "checkin" | "wristband" | "holder" | "ticket" | "undo" | "store";

export function formatHistoryPeriodLabel(input: {
  period: HistoryPeriodPreset;
  dateFrom: string;
  dateTo: string;
}) {
  const [year, month, day] = input.dateFrom.split("-");
  const prettyFrom = year && month && day ? `${day}/${month}/${year}` : input.dateFrom;
  const [toYear, toMonth, toDay] = input.dateTo.split("-");
  const prettyTo = toYear && toMonth && toDay ? `${toDay}/${toMonth}/${toYear}` : input.dateTo;
  const prettyRange = input.dateFrom === input.dateTo ? prettyFrom : `${prettyFrom} → ${prettyTo}`;
  if (input.period === "today") return `Hoje · ${prettyRange} · America/Sao_Paulo`;
  if (input.period === "yesterday") return `Ontem · ${prettyRange} · America/Sao_Paulo`;
  if (input.period === "7d") return `7 dias · ${prettyRange} · America/Sao_Paulo`;
  if (input.period === "30d") return `30 dias · ${prettyRange} · America/Sao_Paulo`;
  return `Personalizado · ${prettyRange} · America/Sao_Paulo`;
}

export function extraHistoryFilterCount(input: {
  period: HistoryPeriodPreset;
  category: OperationHistoryCategory | "all";
  operatorUserId: string;
  shirtType?: string | null;
  shirtSize?: string | null;
}) {
  let count = 0;
  if (input.period !== "today") count += 1;
  if (input.category !== "all") count += 1;
  if (input.operatorUserId) count += 1;
  if (input.shirtType) count += 1;
  if (input.shirtSize) count += 1;
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
  if (period === "today" || period === "yesterday") return clock;

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

export function shirtDeliverySummaryCards(summary: {
  periodDeliveries: number;
  periodUndos: number;
  currentlyDelivered: number | null;
}) {
  return [
    {
      key: "saidas",
      label: "Saídas no período",
      short: "Saídas",
      value: summary.periodDeliveries,
      hint: "Eventos de entrega ocorridos no período filtrado.",
    },
    {
      key: "undos",
      label: "Undos no período",
      short: "Undos",
      value: summary.periodUndos,
      hint: "Eventos de desfazer ocorridos no período filtrado.",
    },
    {
      key: "estoqueAtual",
      label: "Estoque atual entregue",
      short: "Estoque atual",
      value: summary.currentlyDelivered,
      hint: "delivered_quantity atual desta variante. Não é o saldo do período.",
    },
  ] as const;
}
