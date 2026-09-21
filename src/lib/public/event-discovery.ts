import { formatDateBR } from "../utils/date.ts";

export type EventDiscoveryInput = {
  id: string;
  name: string;
  slug: string;
  year: number | null;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  registrationEnabled: boolean;
  registrationOpenAt: string | null;
  registrationCloseAt: string | null;
  bannerCardUrl?: string | null;
  bannerHeroUrl?: string | null;
};

export type EventDiscoveryStatus = "open" | "sales_closed" | "ended";

export type EventDiscoveryCard = {
  id: string;
  name: string;
  title: string;
  slug: string;
  location: string;
  date: string;
  bannerUrl: string | null;
  status: EventDiscoveryStatus;
  statusLabel: string;
  footnote: string | null;
  eventHref: string;
  buyHref: string | null;
  primaryCtaLabel: string;
  primaryCtaHref: string;
};

export function isEventSalesOpen(event: Pick<EventDiscoveryInput, "registrationEnabled" | "registrationOpenAt" | "registrationCloseAt">, now = Date.now()) {
  if (!event.registrationEnabled) return false;
  const openOk = !event.registrationOpenAt || new Date(event.registrationOpenAt).getTime() <= now;
  const closeOk = !event.registrationCloseAt || new Date(event.registrationCloseAt).getTime() >= now;
  return openOk && closeOk;
}

export function isEventEnded(event: Pick<EventDiscoveryInput, "startsAt" | "endsAt">, now = Date.now()) {
  const end = event.endsAt ?? event.startsAt;
  if (!end) return false;
  return new Date(end).getTime() < now;
}

export function sortPublicEventsForDiscovery<T extends Pick<EventDiscoveryInput, "startsAt" | "endsAt" | "name">>(events: T[], now = Date.now()) {
  const upcoming = events
    .filter((event) => !isEventEnded(event, now))
    .sort((a, b) => (a.startsAt ?? "").localeCompare(b.startsAt ?? "") || a.name.localeCompare(b.name, "pt-BR"));
  const past = events
    .filter((event) => isEventEnded(event, now))
    .sort((a, b) => (b.startsAt ?? "").localeCompare(a.startsAt ?? "") || a.name.localeCompare(b.name, "pt-BR"));
  return [...upcoming, ...past];
}

export function presentPublicEventDiscovery(event: EventDiscoveryInput, now = Date.now()): EventDiscoveryCard {
  const ended = isEventEnded(event, now);
  const salesOpen = !ended && isEventSalesOpen(event, now);
  const status: EventDiscoveryStatus = ended ? "ended" : salesOpen ? "open" : "sales_closed";
  const slug = String(event.slug ?? "").trim();
  const eventHref = slug ? `/eventos/${slug}` : "/eventos";
  const buyHref = slug && salesOpen ? `/inscricao/${slug}` : null;
  return {
    id: event.id,
    name: event.name,
    title: event.year ? `${event.name} ${event.year}` : event.name,
    slug,
    location: event.location?.trim() || "Local a confirmar",
    date: event.startsAt ? formatDateBR(event.startsAt) : "Data a confirmar",
    bannerUrl: event.bannerCardUrl || event.bannerHeroUrl || null,
    status,
    statusLabel: ended ? "Encerrado" : salesOpen ? "Vendas abertas" : "Vendas fechadas",
    footnote: ended
      ? null
      : salesOpen
        ? null
        : "Inscrições/vendas ainda não estão abertas",
    eventHref,
    buyHref,
    primaryCtaLabel: salesOpen ? "Comprar ingresso" : "Ver evento",
    primaryCtaHref: salesOpen && buyHref ? buyHref : eventHref,
  };
}
