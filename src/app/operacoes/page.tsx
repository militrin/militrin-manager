"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import {
  checkinEntryAction,
  deliverFullKitAction,
  deliverKitAndCheckinAction,
  deliverKitItemAction,
  deliverAdditionalStoreItemAction,
  grantStoreItemAction,
  getPickupEventsAction,
  getOperationTicketDetailsAction,
  getOperationParticipantDetailsAction,
  getRetiradaCapabilitiesAction,
  linkWristbandAction,
  listOperationTicketsAction,
  replaceWristbandAction,
  searchPickupParticipantByQrAction,
  undoCheckinEntryAction,
  undoFullKitDeliveryAction,
  unlinkWristbandAction,
} from "./actions";
import { confirmParticipantPaymentAction } from "@/app/inscricoes/actions";
import { OperationsDashboard } from "./components/OperationsDashboard";
import { OperationsFilters } from "./components/OperationsFilters";
import { OperationsHeader } from "./components/OperationsHeader";
import { OperationsTable } from "./components/OperationsTable";
import { QrScannerModal } from "./components/QrScannerModal";
import { OrderItemProductQrModal } from "./components/OrderItemProductQrModal";
import { BatchMaterializeItemsDialog } from "./components/MaterializeItemsDialog";
import { OperationalErrorDialog } from "./components/OperationalErrorDialog";
import { getOperationalErrorTitle } from "./error-messages";
import {
  EMPTY_PICKUP_FILTERS,
  type OrderItemProductDetails,
  type PickupCapabilities,
  type PickupDetails,
  type PickupEvent,
  type PickupFilters,
  type PickupListGroup,
  type PickupListItem,
  type PickupSortDirection,
  type PickupSortField,
} from "./types";

const VIEW_STATE_STORAGE_KEY = "operacoes.view-state.v1";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHIRT_TYPE_RANK = new Map<string, number>([["camiseta", 0], ["babylook", 1]]);
const SHIRT_SIZE_RANK = new Map<string, number>([
  ["PP", 0],
  ["P", 1],
  ["M", 2],
  ["G", 3],
  ["GG", 4],
  ["EG", 5],
  ["EXG", 6],
  ["EXGG", 7],
]);

function normalizeText(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function getAge(birthDate: string | null) {
  if (!birthDate) return null;
  const date = new Date(birthDate);
  if (Number.isNaN(date.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - date.getFullYear();
  const monthDiff = now.getMonth() - date.getMonth();

  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < date.getDate())) {
    age -= 1;
  }

  return age >= 0 ? age : null;
}

function inAgeGroup(age: number | null, ageGroup: string) {
  if (ageGroup === "all") return true;
  if (age === null) return false;
  if (ageGroup === "lt18") return age < 18;
  if (ageGroup === "18to29") return age >= 18 && age <= 29;
  if (ageGroup === "30to39") return age >= 30 && age <= 39;
  if (ageGroup === "40to49") return age >= 40 && age <= 49;
  if (ageGroup === "50plus") return age >= 50;
  return true;
}

function isEmptyValue(value: unknown) {
  return value === null || value === undefined || String(value).trim() === "";
}

function compareNullable(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  direction: PickupSortDirection,
) {
  const aEmpty = isEmptyValue(a);
  const bEmpty = isEmptyValue(b);

  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const multiplier = direction === "asc" ? 1 : -1;

  if (typeof a === "number" && typeof b === "number") {
    return (a - b) * multiplier;
  }

  return String(a).localeCompare(String(b), "pt-BR", { sensitivity: "base" }) * multiplier;
}

function getSortValue(item: PickupListItem, field: PickupSortField) {
  if (field === "name") return item.buyer_name || item.participant_name;
  if (field === "city") return item.city;
  if (field === "gender") return item.gender ?? null;
  if (field === "age") return getAge(item.birth_date);
  if (field === "shirt_type") return item.shirt_type;
  if (field === "shirt_size") return item.shirt_size;
  if (field === "payment") return item.payment_status;
  if (field === "kit") return item.kit_status;
  if (field === "checkin") return item.checkin_status;
  return item.wristband?.status ?? null;
}

function compareByField(
  a: PickupListItem,
  b: PickupListItem,
  field: PickupSortField,
  direction: PickupSortDirection,
) {
  if (field === "shirt_type") {
    const aRank = SHIRT_TYPE_RANK.get(String(a.shirt_type ?? "").toLowerCase());
    const bRank = SHIRT_TYPE_RANK.get(String(b.shirt_type ?? "").toLowerCase());
    const rankCompare = compareNullable(aRank ?? null, bRank ?? null, direction);
    return rankCompare !== 0 ? rankCompare : compareNullable(a.shirt_type, b.shirt_type, direction);
  }

  if (field === "shirt_size") {
    const aRank = SHIRT_SIZE_RANK.get(String(a.shirt_size ?? "").toUpperCase());
    const bRank = SHIRT_SIZE_RANK.get(String(b.shirt_size ?? "").toUpperCase());
    const rankCompare = compareNullable(aRank ?? null, bRank ?? null, direction);
    return rankCompare !== 0 ? rankCompare : compareNullable(a.shirt_size, b.shirt_size, direction);
  }

  if (field === "payment") {
    const paymentRank = (status: string) => {
      if (status === "paid") return 0;
      if (status === "pending") return 1;
      return 2;
    };

    const rankCompare = compareNullable(paymentRank(a.payment_status), paymentRank(b.payment_status), direction);
    return rankCompare !== 0 ? rankCompare : compareNullable(a.payment_status, b.payment_status, direction);
  }

  if (field === "kit") {
    const kitRank = (status: string) => {
      if (status === "pending") return 0;
      if (status === "partial") return 1;
      if (status === "configuration_pending") return 2;
      if (status === "delivered") return 3;
      if (status === "none") return 4;
      return 5;
    };

    const rankCompare = compareNullable(kitRank(a.kit_status), kitRank(b.kit_status), direction);
    return rankCompare !== 0 ? rankCompare : compareNullable(a.kit_status, b.kit_status, direction);
  }

  if (field === "checkin") {
    const checkinRank = (status: string) => (status === "pending" ? 0 : 1);
    return compareNullable(checkinRank(a.checkin_status), checkinRank(b.checkin_status), direction);
  }

  if (field === "wristband") {
    const wristbandRank = (item: PickupListItem) => (item.wristband?.status === "active" ? 0 : 1);
    const rankCompare = compareNullable(wristbandRank(a), wristbandRank(b), direction);
    if (rankCompare !== 0) return rankCompare;
    return compareNullable(a.wristband?.code ?? null, b.wristband?.code ?? null, direction);
  }

  return compareNullable(
    getSortValue(a, field),
    getSortValue(b, field),
    direction,
  );
}

function isPending(item: PickupListItem) {
  if (item.kind !== "ticket") return false;
  if (item.payment_status !== "paid") return true;
  if (item.checkin_status !== "done") return true;
  if (item.event_has_kit && item.kit_status !== "delivered" && item.kit_status !== "none") return true;
  if (item.event_wristband_enabled && item.wristband?.status !== "active") return true;
  return false;
}

function isConcluded(item: PickupListItem, selectedEvent: PickupEvent | null) {
  if (item.kind !== "ticket") return false;
  if (!selectedEvent?.has_kit) {
    return item.checkin_status === "done";
  }

  return item.checkin_status === "done" && (item.kit_status === "delivered" || item.kit_status === "none");
}

function detailToListItem(detail: PickupDetails): PickupListItem {
  return {
    kind: detail.kind,
    id: detail.id,
    ticket_id: detail.ticket_id,
    ticket_token: detail.ticket_token,
    ticket_status: detail.ticket_status,
    ticket_used_at: detail.ticket_used_at,
    ticket_issued_at: detail.ticket_issued_at,
    participant_id: detail.participant_id,
    participant_name: detail.participant_name,
    participant_email: detail.participant_email,
    event_id: detail.event_id,
    event_name: detail.event_name,
    category_id: detail.category_id,
    category_name: detail.category_name,
    order_id: detail.order_id,
    order_number: detail.order_number,
    order_created_at: detail.order_created_at,
    buyer_user_id: detail.buyer_user_id,
    buyer_name: detail.buyer_name,
    buyer_cpf: detail.buyer_cpf,
    buyer_phone: detail.buyer_phone,
    buyer_email: detail.buyer_email,
    buyer_type: detail.buyer_type,
    import_batch_id: detail.import_batch_id,
    full_name: detail.full_name,
    cpf: detail.cpf,
    phone: detail.phone,
    city: detail.city,
    gender: detail.gender,
    birth_date: detail.birth_date,
    payment_status: detail.payment_status,
    payment_method: detail.payment_method,
    registration_status: detail.registration_status,
    shirt_type: detail.shirt_type,
    shirt_size: detail.shirt_size,
    kit_status: detail.kit_status,
    checkin_status: detail.checkin_status,
    wristband_id: detail.wristband_id,
    wristband_code: detail.wristband_code,
    wristband_status: detail.wristband_status,
    can_operate: detail.can_operate,
    block_reason: detail.block_reason,
    order_ticket_count: detail.order_ticket_count,
    order_ticket_position: detail.order_ticket_position,
    event_has_kit: detail.event_has_kit,
    event_has_shirt: detail.event_has_shirt,
    event_wristband_enabled: detail.event_wristband_enabled,
    event_wristband_required_for_kit: detail.event_wristband_required_for_kit,
    event_wristband_required_for_checkin: detail.event_wristband_required_for_checkin,
    is_imported_without_ticket: detail.is_imported_without_ticket,
    wristband: detail.wristband,
  } as PickupListItem;
}

function upsertTicketInGroups(current: PickupListGroup[], row: PickupListItem) {
  return current.map((group) => {
    if (!group.tickets.some((ticket) => ticket.id === row.id)) return group;
    return {
      ...group,
      tickets: group.tickets.map((ticket) => (ticket.id === row.id ? row : ticket)),
    };
  });
}

function KitPickupPageContent() {
  const searchParams = useSearchParams();
  const [filters, setFilters] = useState<PickupFilters>(EMPTY_PICKUP_FILTERS);
  const [appliedFilters, setAppliedFilters] = useState<PickupFilters>(EMPTY_PICKUP_FILTERS);
  const [sortField, setSortField] = useState<PickupSortField>("name");
  const [sortDirection, setSortDirection] = useState<PickupSortDirection>("asc");
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [events, setEvents] = useState<PickupEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<PickupEvent | null>(null);
  const [items, setItems] = useState<PickupListItem[]>([]);
  const [visibleItems, setVisibleItems] = useState<PickupListItem[]>([]);
  const [groups, setGroups] = useState<PickupListGroup[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PickupDetails>>({});
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [errorDialog, setErrorDialog] = useState<{ title: string; message: string } | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [orderItemProductModal, setOrderItemProductModal] = useState<OrderItemProductDetails | null>(null);
  const [capabilities, setCapabilities] = useState<PickupCapabilities>({
    canDeliverKit: false,
    canCheckin: false,
    canCombined: false,
    canChangeShirt: false,
    canUndoKit: false,
    canUndoCheckin: false,
    canViewWristband: false,
    canLinkWristband: false,
    canUnlinkWristband: false,
    canReplaceWristband: false,
    canGrantStoreItems: false,
    canDeliverStoreItems: false,
  });

  const shirtTypes = useMemo(
    () => Array.from(new Set(items.map((item) => item.shirt_type).filter(Boolean))).sort(),
    [items],
  );

  const shirtSizes = useMemo(
    () => Array.from(new Set(items.map((item) => item.shirt_size).filter(Boolean))).sort(),
    [items],
  );

  const categories = useMemo(
    () => Array.from(new Set(items.map((item) => item.category_name).filter(Boolean))).sort(),
    [items],
  );

  const cities = useMemo(
    () => Array.from(new Set(items.map((item) => item.city).filter(Boolean))).sort(),
    [items],
  );

  const visibleGroups = useMemo(() => {
    const visibleIndex = new Map(visibleItems.map((item, index) => [item.id, index]));
    return groups
      .map((group) => ({
        ...group,
        tickets: group.tickets
          .filter((ticket) => visibleIndex.has(ticket.id))
          .sort((a, b) => (visibleIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER)
            - (visibleIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER)),
      }))
      .filter((group) => group.tickets.length > 0)
      .sort((a, b) => {
        const aIndex = Math.min(...a.tickets.map((ticket) => visibleIndex.get(ticket.id) ?? Number.MAX_SAFE_INTEGER));
        const bIndex = Math.min(...b.tickets.map((ticket) => visibleIndex.get(ticket.id) ?? Number.MAX_SAFE_INTEGER));
        return aIndex - bIndex;
      });
  }, [groups, visibleItems]);

  const operationSummary = useMemo(() => {
    const totalGroups = visibleGroups.length;
    const totalTickets = visibleGroups.reduce((acc, group) => acc + group.tickets.filter((entry) => entry.kind === "ticket").length, 0);
    const completed = visibleItems.filter((item) => item.kind === "ticket" && isConcluded(item, selectedEvent)).length;
    const pending = Math.max(0, totalTickets - completed);
    // Total carregado do evento ANTES dos filtros locais -- permite o resumo
    // e o estado vazio distinguirem "evento sem ingresso nenhum" de "filtros
    // ativos escondendo ingressos que existem" (estado persistido no
    // localStorage pode fazer os dois parecerem identicos pro operador).
    const totalEventTickets = items.filter((item) => item.kind === "ticket").length;

    return {
      totalGroups,
      totalTickets,
      totalEventTickets,
      pending,
      completed,
    };
  }, [visibleGroups, visibleItems, items, selectedEvent]);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as {
            filters?: PickupFilters;
            appliedFilters?: PickupFilters;
            sortField?: PickupSortField;
            sortDirection?: PickupSortDirection;
          };

          setFilters({ ...EMPTY_PICKUP_FILTERS, ...(parsed.filters ?? {}) });
          setAppliedFilters({ ...EMPTY_PICKUP_FILTERS, ...(parsed.appliedFilters ?? parsed.filters ?? {}) });
          setSortField(parsed.sortField ?? "name");
          setSortDirection(parsed.sortDirection ?? "asc");
        }
      } catch {
        // Ignore invalid localStorage payload and keep deterministic defaults.
      } finally {
        setPreferencesLoaded(true);
      }
    });
  }, []);

  function buildLocalView(
    sourceItems: PickupListItem[],
    activeFilters: PickupFilters,
    activeSortField: PickupSortField,
    activeSortDirection: PickupSortDirection,
  ) {
    const search = normalizeText(activeFilters.search);

    const filtered = sourceItems.filter((item) => {
      if (search) {
        const haystack = normalizeText([
          item.participant_name,
          item.participant_email,
          item.cpf,
          item.phone,
          item.buyer_name,
          item.buyer_cpf,
          item.buyer_phone,
          item.buyer_email,
        ].join(" "));
        if (!haystack.includes(search)) return false;
      }

      if (activeFilters.category !== "all" && item.category_name !== activeFilters.category) return false;
      if (activeFilters.city !== "all" && item.city !== activeFilters.city) return false;
      if (activeFilters.gender === "not_informed" && item.gender) return false;
      if (activeFilters.gender !== "all" && activeFilters.gender !== "not_informed" && item.gender !== activeFilters.gender) return false;
      if (!inAgeGroup(getAge(item.birth_date), activeFilters.ageGroup)) return false;
      if (activeFilters.paymentStatus !== "all" && item.payment_status !== activeFilters.paymentStatus) return false;
      if (activeFilters.kitStatus !== "all" && item.kit_status !== activeFilters.kitStatus) return false;
      if (activeFilters.checkinStatus !== "all" && item.checkin_status !== activeFilters.checkinStatus) return false;
      if (activeFilters.wristbandStatus === "active" && item.wristband?.status !== "active") return false;
      if (activeFilters.wristbandStatus === "pending" && item.wristband?.status === "active") return false;
      if (activeFilters.shirtType !== "all" && item.shirt_type !== activeFilters.shirtType) return false;
      if (activeFilters.shirtSize !== "all" && item.shirt_size !== activeFilters.shirtSize) return false;
      if (activeFilters.onlyPending && !isPending(item)) return false;

      return true;
    });

    return filtered
      .slice()
      .sort((a, b) => compareByField(a, b, activeSortField, activeSortDirection));
  }

  function applyView(sourceItems: PickupListItem[], nextAppliedFilters = appliedFilters, nextSortField = sortField, nextSortDirection = sortDirection) {
    setVisibleItems(buildLocalView(sourceItems, nextAppliedFilters, nextSortField, nextSortDirection));
  }

  async function loadList(eventId: string, keepMessage = false) {
    setLoading(true);
    if (!keepMessage) setMessage(null);

    let response: Awaited<ReturnType<typeof listOperationTicketsAction>>;

    try {
      response = await listOperationTicketsAction({ eventId });
    } catch (error) {
      setLoading(false);
      setItems([]);
      setVisibleItems([]);
      setGroups([]);
      setMessage(error instanceof Error ? error.message : "Não foi possível carregar a lista.");
      return;
    }

    setLoading(false);

    if (!response.success) {
      setItems([]);
      setVisibleItems([]);
      setGroups([]);
      setMessage(response.message ?? "Não foi possível carregar a lista.");
      return;
    }

    const loadedItems = response.tickets;
    const loadedGroups = response.groups ?? [];
    setItems(loadedItems);
    setGroups(loadedGroups);
    applyView(loadedItems);

    if (expandedId && !loadedItems.some((item) => item.id === expandedId)) {
      setExpandedId(null);
    }

    if (response.event) {
      const matchedEvent = events.find((event) => event.id === response.event?.id) ?? {
        id: response.event.id,
        name: response.event.name,
        is_active: false,
        starts_at: null,
        has_kit: response.event.has_kit,
        has_shirt: response.event.has_shirt,
        wristband_enabled: response.event.wristband_enabled,
        wristband_required_for_kit: response.event.wristband_required_for_kit,
        wristband_required_for_checkin: response.event.wristband_required_for_checkin,
      };

      setSelectedEvent(matchedEvent);
    }
  }

  useEffect(() => {
    if (!preferencesLoaded) return;

    void (async () => {
      const [capabilityResponse, eventsResponse] = await Promise.all([
        getRetiradaCapabilitiesAction().catch(() => ({
          success: false as const,
          capabilities: {
            canDeliverKit: false,
            canCheckin: false,
            canCombined: false,
            canChangeShirt: false,
          },
        })),
        getPickupEventsAction().catch((error) => ({
          success: false as const,
          message: error instanceof Error ? error.message : "Não foi possível carregar os eventos.",
          events: [] as PickupEvent[],
        })),
      ]);

      if (capabilityResponse.success) {
        setCapabilities(capabilityResponse.capabilities);
      }

      if (!eventsResponse.success) {
        setMessage(eventsResponse.message ?? "Não foi possível carregar os eventos.");
        setLoading(false);
        return;
      }

      const loadedEvents = eventsResponse.events as PickupEvent[];
      setEvents(loadedEvents);

      // Regra: um eventId persistido (localStorage) so e respeitado se ainda
      // existir na lista atual. Caso contrario -- e sempre no primeiro acesso,
      // quando filters.eventId comeca vazio -- cai para o evento ativo mais
      // recente e, na falta de um ativo, para o primeiro da lista (loadedEvents
      // ja vem ordenado is_active desc, starts_at desc). So mostra "Nenhum
      // evento encontrado" quando a organizacao realmente nao tem evento algum;
      // antes, eventId vazio bastava pra cair aqui mesmo com eventos existindo.
      const preferredEvent =
        (filters.eventId ? loadedEvents.find((event) => event.id === filters.eventId) : undefined) ??
        loadedEvents.find((event) => event.is_active) ??
        loadedEvents[0] ??
        null;

      if (!preferredEvent) {
        setMessage("Nenhum evento encontrado.");
        setLoading(false);
        return;
      }

      setSelectedEvent(preferredEvent);

      const nextFilters = {
        ...filters,
        eventId: preferredEvent.id,
      };
      const nextApplied = {
        ...appliedFilters,
        eventId: preferredEvent.id,
      };

      setFilters(nextFilters);
      setAppliedFilters(nextApplied);

      await loadList(preferredEvent.id);
    })();
    // Carrega somente ao abrir a tela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesLoaded]);

  // "Abrir operação completa" no Modo Turbo (rota separada, /operacoes/turbo)
  // volta pra ca via /operacoes?eventId=...&focusTicket=<ticket_id> -- esta
  // troca busca o ingresso e expande a ficha, mesmo comportamento de antes
  // quando o Turbo era um overlay na mesma pagina.
  useEffect(() => {
    if (!preferencesLoaded) return;
    const focusTicketId = searchParams.get("focusTicket");
    if (!focusTicketId || !UUID_PATTERN.test(focusTicketId)) return;

    void (async () => {
      const response = await getOperationTicketDetailsAction(focusTicketId);
      if (!response.success || !response.participant || response.participant.kind !== "ticket") return;
      insertAndFocusTicket(response.participant as PickupDetails & { ticket_id: string });
    })();
    // So processa o focusTicket presente no carregamento inicial da pagina.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesLoaded]);

  useEffect(() => {
    if (typeof window === "undefined" || !preferencesLoaded) return;

    window.localStorage.setItem(
      VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        filters,
        appliedFilters,
        sortField,
        sortDirection,
      }),
    );
  }, [filters, appliedFilters, sortField, sortDirection, preferencesLoaded]);

  useEffect(() => {
    if (!preferencesLoaded) return;

    const timeoutId = window.setTimeout(() => {
      setAppliedFilters(filters);
      applyView(items, filters, sortField, sortDirection);
    }, filters.search ? 220 : 120);

    return () => {
      window.clearTimeout(timeoutId);
    };
  // applyView usa exatamente os estados listados abaixo como defaults; inclui-la
  // recriaria o timer em toda renderizacao porque ela tambem atualiza estado.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, items, sortField, sortDirection, preferencesLoaded]);

  async function toggleDetails(entry: PickupListItem) {
    const entryId = entry.id;
    if (expandedId === entryId) {
      setExpandedId(null);
      return;
    }

    setExpandedId(entryId);

    if (details[entryId]) return;

    setActionId(entryId);
    const response = entry.kind === "ticket"
      ? UUID_PATTERN.test(entry.ticket_id)
        ? await getOperationTicketDetailsAction(entry.ticket_id)
        : { success: false as const, message: "Identificador de ingresso inválido." }
      : await getOperationParticipantDetailsAction(entry.participant_id);
    setActionId(null);

    if (!response.success || !response.participant) {
      setMessage(response.message ?? "Não foi possível carregar os detalhes.");
      return;
    }

    setDetails((current) => ({
      ...current,
      [entryId]: response.participant as PickupDetails,
    }));
  }

  async function refreshTicket(ticketId: string) {
    if (!UUID_PATTERN.test(ticketId)) return;
    const response = await getOperationTicketDetailsAction(ticketId);

    if (!response.success || !response.participant) return;

    const participant = response.participant as PickupDetails;
    const row = detailToListItem(participant);

    setDetails((current) => ({
      ...current,
      [ticketId]: participant,
    }));

    setItems((current) => current.map((item) => (item.id === ticketId ? row : item)));
    setVisibleItems((current) => current.map((item) => (item.id === ticketId ? row : item)));
    setGroups((current) => upsertTicketInGroups(current, row));
  }

  // Toda acao operacional disparada por botao manual na ficha/linha (nunca
  // pelo fluxo automatico de QR, que nao passa por aqui) continua jogando a
  // mensagem no banner global (setMessage, tratamento existente, preservado)
  // E, adicionalmente, abre um popup local/imediato pro erro -- exceto
  // WRISTBAND_REQUIRED, que ja abre o proprio WristbandCodeModal (mais util
  // que um popup so informativo) no componente que chamou runAction.
  function openErrorDialogFor(response: { success: boolean; message?: string; code?: string }) {
    if (response.success || response.code === "WRISTBAND_REQUIRED") return;
    const message = response.message ?? "Não foi possível concluir a operação.";
    setErrorDialog({ title: getOperationalErrorTitle(response.code, message), message });
  }

  async function runAction(
    ticketId: string,
    action: () => Promise<{ success: boolean; message?: string; code?: string }>,
  ) {
    if (!UUID_PATTERN.test(ticketId)) {
      const failure = { success: false as const, message: "Identificador de ingresso inválido." };
      setMessage(failure.message);
      openErrorDialogFor(failure);
      return failure;
    }
    setActionId(ticketId);
    setMessage(null);

    try {
      const response = await action();
      setMessage(response.message ?? (response.success ? "Operação concluída." : "Operação não concluída."));
      openErrorDialogFor(response);

      // WRISTBAND_REQUIRED nunca atualiza a lista -- nada mudou no banco
      // ainda, o frontend so vai abrir o modal obrigatorio e tentar de novo
      // com o codigo.
      if (response.success || response.code === "SHIRT_OUT_OF_STOCK") {
        await refreshTicket(ticketId);
      }
      return response;
    } catch (error) {
      const failure = { success: false as const, message: error instanceof Error ? error.message : "Falha inesperada." };
      setMessage(failure.message);
      openErrorDialogFor(failure);
      return failure;
    } finally {
      setActionId(null);
    }
  }

  // Insere/atualiza um ingresso resolvido (por QR ou por ?focusTicket= vindo
  // de outra rota, ex. "Abrir operação completa" no Modo Turbo) na tabela
  // visivel, expande a ficha e rola ate ela. Compartilhado pelas duas
  // origens pra nao duplicar a logica de merge em items/visibleItems/groups.
  function insertAndFocusTicket(participant: PickupDetails & { ticket_id: string }) {
    const row = detailToListItem(participant);

    setDetails((current) => ({ ...current, [participant.ticket_id]: participant }));
    setExpandedId(participant.ticket_id);

    setItems((current) => {
      if (current.some((item) => item.id === participant.ticket_id)) {
        return current.map((item) => (item.id === participant.ticket_id ? row : item));
      }
      return [row, ...current];
    });

    setVisibleItems((current) => {
      if (current.some((item) => item.id === participant.ticket_id)) {
        return current.map((item) => (item.id === participant.ticket_id ? row : item));
      }
      return [row, ...current];
    });

    setGroups((current) => upsertTicketInGroups(current, row));

    window.setTimeout(() => {
      document.getElementById(`participant-${participant.ticket_id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 150);
  }

  async function handleQrRead(value: string) {
    setMessage(null);
    const response = await searchPickupParticipantByQrAction(value);

    if (!response.success) {
      setMessage(response.message ?? "Participante não encontrado.");
      return;
    }

    // Produto "compre junto" (order_items) -- dominio DIFERENTE de ingresso,
    // resolve pra uma tela propria (modal), nunca entra na tabela de
    // participantes. O evento e derivado do proprio order_item/order (nunca
    // exigido do cliente pra resolver o QR) -- so validado AQUI, depois da
    // resolucao, igual ao ingresso logo abaixo.
    if (response.participant.kind === "order_item_product") {
      if (response.participant.event_id !== selectedEvent?.id) {
        setMessage("Produto encontrado em outro evento. Selecione o evento correspondente para operar.");
        return;
      }
      setShowScanner(false);
      setOrderItemProductModal(response.participant);
      return;
    }

    const participant = response.participant as PickupDetails;

    if (participant.kind !== "ticket" || !UUID_PATTERN.test(participant.ticket_id)) {
      setMessage("O QR Code não corresponde a um ingresso válido.");
      return;
    }

    if (participant.event_id !== selectedEvent?.id) {
      setMessage("Participante encontrado em outro evento. Selecione o evento correspondente para operar.");
      return;
    }

    setShowScanner(false);
    insertAndFocusTicket(participant as PickupDetails & { ticket_id: string });
  }

  async function handleEventChange(eventId: string) {
    const nextEvent = events.find((item) => item.id === eventId) ?? null;
    const nextFilters = {
      ...filters,
      eventId,
      shirtType: "all",
      shirtSize: "all",
      wristbandStatus: "all",
    };
    const nextApplied = {
      ...appliedFilters,
      eventId,
      shirtType: "all",
      shirtSize: "all",
      wristbandStatus: "all",
    };

    setSelectedEvent(nextEvent);
    setFilters(nextFilters);
    setAppliedFilters(nextApplied);

    await loadList(eventId);
  }

  function handleFilterChange<K extends keyof PickupFilters>(
    key: K,
    value: PickupFilters[K],
  ) {
    setFilters((current) => ({
      ...current,
      [key]: value,
    }));
  }

  function handleSort(field: PickupSortField) {
    const nextDirection: PickupSortDirection =
      field === sortField
        ? (sortDirection === "asc" ? "desc" : "asc")
        : "asc";

    setSortField(field);
    setSortDirection(nextDirection);
    applyView(items, appliedFilters, field, nextDirection);
  }

  function handleSortPreset(field: PickupSortField, direction: PickupSortDirection) {
    setSortField(field);
    setSortDirection(direction);
    applyView(items, appliedFilters, field, direction);
  }

  function handleClearFilters() {
    const cleared = {
      ...EMPTY_PICKUP_FILTERS,
      eventId: selectedEvent?.id ?? filters.eventId,
    };

    setFilters(cleared);
    setAppliedFilters(cleared);
    applyView(items, cleared, sortField, sortDirection);
  }

  async function handleDeliverFullKit(ticketId: string, _participantId: string | null, wristbandCode?: string) {
    void _participantId;
    return runAction(ticketId, () =>
      deliverFullKitAction({ ticket_id: ticketId, wristband_code: wristbandCode }),
    );
  }

  async function handleDeliverKitAndCheckin(ticketId: string, participantId: string | null, wristbandCode?: string) {
    void participantId;
    return runAction(ticketId, () =>
      deliverKitAndCheckinAction({ ticket_id: ticketId, wristband_code: wristbandCode }),
    );
  }

  async function handleCheckin(ticketId: string, wristbandCode?: string) {
    return runAction(ticketId, () =>
      checkinEntryAction({ ticket_id: ticketId, wristband_code: wristbandCode }),
    );
  }

  async function handleUndoCheckin(ticketId: string, payload: { reasonCode: string; reasonText: string; alsoUnlinkWristband: boolean }) {
    return runAction(ticketId, () =>
      undoCheckinEntryAction({
        ticket_id: ticketId,
        reason_code: payload.reasonCode,
        reason_text: payload.reasonText,
        also_unlink_wristband: payload.alsoUnlinkWristband,
      }),
    );
  }

  async function handleUndoKitDelivery(ticketId: string, payload: { reasonCode: string; reasonText: string }) {
    return runAction(ticketId, () =>
      undoFullKitDeliveryAction({ ticket_id: ticketId, reason_code: payload.reasonCode, reason_text: payload.reasonText }),
    );
  }

  async function handleLinkWristband(ticketId: string, code: string) {
    return runAction(ticketId, () => linkWristbandAction({ ticket_id: ticketId, code }));
  }

  async function handleUnlinkWristband(ticketId: string) {
    return runAction(ticketId, () => unlinkWristbandAction({ ticket_id: ticketId }));
  }

  async function handleReplaceWristband(ticketId: string, code: string) {
    return runAction(ticketId, () => replaceWristbandAction({ ticket_id: ticketId, new_code: code }));
  }

  async function handleConfirmPayment(ticketId: string, participantId: string) {
    await runAction(ticketId, () => confirmParticipantPaymentAction(participantId));
  }

  async function handleDeliverKitItem(ticketId: string, _participantId: string | null, kitItemId: string, wristbandCode?: string) {
    void _participantId;
    return runAction(ticketId, () =>
      deliverKitItemAction({
        ticket_id: ticketId,
        kit_item_id: kitItemId,
        wristband_code: wristbandCode,
      }),
    );
  }

  async function handleGrantStoreItem(
    ticketId: string,
    payload: { storeItemId: string; variantId: string | null; quantity: number; isCourtesy: boolean; reason?: string },
  ) {
    return runAction(ticketId, () => grantStoreItemAction({ ticketId, ...payload }));
  }

  async function handleDeliverAdditionalItem(ticketId: string, storeOrderItemId: string) {
    return runAction(ticketId, () => deliverAdditionalStoreItemAction(storeOrderItemId));
  }

  async function handleParticipantResolved(
    participantId: string,
    result: { ticketId: string | null; finalization: string | null; message: string },
  ) {
    setMessage(result.message);
    setDetails((current) => {
      const next = { ...current };
      delete next[participantId];
      return next;
    });
    setExpandedId(null);
    if (selectedEvent?.id) await loadList(selectedEvent.id, true);
  }

  async function handleItemsMaterialized(ticketId?: string) {
    if (ticketId) {
      setDetails((current) => {
        const next = { ...current };
        delete next[ticketId];
        return next;
      });
    } else {
      setDetails({});
    }
    if (selectedEvent) await loadList(selectedEvent.id, true);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      {showScanner ? (
        <QrScannerModal
          onClose={() => setShowScanner(false)}
          onRead={handleQrRead}
        />
      ) : null}

      {orderItemProductModal ? (
        <OrderItemProductQrModal
          item={orderItemProductModal}
          onClose={() => setOrderItemProductModal(null)}
          onDelivered={() => setOrderItemProductModal(null)}
        />
      ) : null}

      {errorDialog ? (
        <OperationalErrorDialog
          title={errorDialog.title}
          message={errorDialog.message}
          onClose={() => setErrorDialog(null)}
        />
      ) : null}

      <div className="mx-auto flex max-w-[1600px] flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="min-w-0 flex-1 space-y-6">
          <OperationsHeader />

          <SectionCard
            title="Operação do evento"
            description="Filtre localmente e execute as ações operacionais sem perder o estado visual da tela."
          >
            {selectedEvent && visibleItems.some((item) => item.kind === "ticket" && item.kit_status === "configuration_pending") && capabilities.canDeliverKit ? (
              <div className="mb-3 flex justify-end">
                <BatchMaterializeItemsDialog
                  eventId={selectedEvent.id}
                  count={visibleItems.filter((item) => item.kind === "ticket" && item.kit_status === "configuration_pending").length}
                  onSuccess={() => handleItemsMaterialized()}
                />
              </div>
            ) : null}
            <OperationsFilters
              filters={filters}
              events={events}
              selectedEvent={selectedEvent}
              shirtTypes={shirtTypes}
              shirtSizes={shirtSizes}
              categories={categories}
              cities={cities}
              loading={loading}
              summary={operationSummary}
              onEventChange={(eventId) => {
                void handleEventChange(eventId);
              }}
              onFilterChange={handleFilterChange}
              onClearAllFilters={handleClearFilters}
              onOpenScanner={() => setShowScanner(true)}
            />

            <OperationsDashboard message={message}>
              <OperationsTable
                selectedEvent={selectedEvent}
                groups={visibleGroups}
                items={visibleItems}
                totalLoadedCount={items.length}
                onClearFilters={handleClearFilters}
                details={details}
                expandedId={expandedId}
                actionId={actionId}
                loading={loading}
                capabilities={capabilities}
                sortField={sortField}
                sortDirection={sortDirection}
                onSort={handleSort}
                onSortPreset={handleSortPreset}
                onToggleDetails={toggleDetails}
                onDeliverFullKit={handleDeliverFullKit}
                onDeliverKitAndCheckin={handleDeliverKitAndCheckin}
                onCheckin={handleCheckin}
                onDeliverKitItem={handleDeliverKitItem}
                onUndoCheckin={handleUndoCheckin}
                onUndoKitDelivery={handleUndoKitDelivery}
                onLinkWristband={handleLinkWristband}
                onUnlinkWristband={handleUnlinkWristband}
                onReplaceWristband={handleReplaceWristband}
                onItemsMaterialized={handleItemsMaterialized}
                onParticipantResolved={handleParticipantResolved}
                onConfirmPayment={handleConfirmPayment}
                onGrantStoreItem={handleGrantStoreItem}
                onDeliverAdditionalItem={handleDeliverAdditionalItem}
              />
            </OperationsDashboard>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}

export default function KitPickupPage() {
  return (
    <Suspense fallback={null}>
      <KitPickupPageContent />
    </Suspense>
  );
}
