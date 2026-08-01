"use client";

import { useEffect, useMemo, useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import {
  checkinEntryAction,
  deliverFullKitAction,
  deliverKitAndCheckinAction,
  deliverKitItemAction,
  getPickupEventsAction,
  getPickupParticipantDetailsAction,
  getRetiradaCapabilitiesAction,
  listPickupParticipantsAction,
  searchPickupParticipantByQrAction,
} from "./actions";
import { OperationsDashboard } from "./components/OperationsDashboard";
import { OperationsFilters } from "./components/OperationsFilters";
import { OperationsHeader } from "./components/OperationsHeader";
import { OperationsTable } from "./components/OperationsTable";
import { QrScannerModal } from "./components/QrScannerModal";
import {
  EMPTY_PICKUP_FILTERS,
  type PickupCapabilities,
  type PickupDetails,
  type PickupEvent,
  type PickupFilters,
  type PickupListItem,
  type PickupSortDirection,
  type PickupSortField,
} from "./types";

const VIEW_STATE_STORAGE_KEY = "operacoes.view-state.v1";
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
  if (field === "name") return item.full_name;
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
      if (status === "delivered") return 2;
      if (status === "none") return 3;
      return 4;
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
  if (item.payment_status !== "paid") return true;
  if (item.checkin_status !== "done") return true;
  if (item.event_has_kit && item.kit_status !== "delivered" && item.kit_status !== "none") return true;
  if (item.event_wristband_enabled && item.wristband?.status !== "active") return true;
  return false;
}

function getInitialViewState() {
  if (typeof window === "undefined") {
    return {
      filters: EMPTY_PICKUP_FILTERS,
      appliedFilters: EMPTY_PICKUP_FILTERS,
      sortField: "name" as PickupSortField,
      sortDirection: "asc" as PickupSortDirection,
    };
  }

  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) throw new Error("empty");
    const parsed = JSON.parse(raw) as {
      filters?: PickupFilters;
      appliedFilters?: PickupFilters;
      sortField?: PickupSortField;
      sortDirection?: PickupSortDirection;
    };

    return {
      filters: { ...EMPTY_PICKUP_FILTERS, ...(parsed.filters ?? {}) },
      appliedFilters: { ...EMPTY_PICKUP_FILTERS, ...(parsed.appliedFilters ?? parsed.filters ?? {}) },
      sortField: parsed.sortField ?? "name",
      sortDirection: parsed.sortDirection ?? "asc",
    };
  } catch {
    return {
      filters: EMPTY_PICKUP_FILTERS,
      appliedFilters: EMPTY_PICKUP_FILTERS,
      sortField: "name" as PickupSortField,
      sortDirection: "asc" as PickupSortDirection,
    };
  }
}

function detailToListItem(detail: PickupDetails): PickupListItem {
  return {
    id: detail.id,
    event_id: detail.event_id,
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
    category_name: detail.category_name,
    event_name: detail.event_name,
    ticket_id: detail.ticket_id,
    ticket_status: detail.ticket_status,
    ticket_used_at: detail.ticket_used_at,
    kit_status: detail.kit_status,
    checkin_status: detail.checkin_status,
    can_operate: detail.can_operate,
    block_reason: detail.block_reason,
    event_has_kit: detail.event_has_kit,
    event_has_shirt: detail.event_has_shirt,
    event_wristband_enabled: detail.event_wristband_enabled,
    event_wristband_required_for_kit: detail.event_wristband_required_for_kit,
    event_wristband_required_for_checkin: detail.event_wristband_required_for_checkin,
    wristband: detail.wristband,
  };
}

export default function KitPickupPage() {
  const initialViewState = useMemo(() => getInitialViewState(), []);

  const [filters, setFilters] = useState<PickupFilters>(initialViewState.filters);
  const [appliedFilters, setAppliedFilters] = useState<PickupFilters>(initialViewState.appliedFilters);
  const [sortField, setSortField] = useState<PickupSortField>(initialViewState.sortField);
  const [sortDirection, setSortDirection] = useState<PickupSortDirection>(initialViewState.sortDirection);
  const [events, setEvents] = useState<PickupEvent[]>([]);
  const [selectedEvent, setSelectedEvent] = useState<PickupEvent | null>(null);
  const [items, setItems] = useState<PickupListItem[]>([]);
  const [visibleItems, setVisibleItems] = useState<PickupListItem[]>([]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, PickupDetails>>({});
  const [loading, setLoading] = useState(true);
  const [actionId, setActionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showScanner, setShowScanner] = useState(false);
  const [capabilities, setCapabilities] = useState<PickupCapabilities>({
    canDeliverKit: false,
    canCheckin: false,
    canCombined: false,
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

  function buildLocalView(
    sourceItems: PickupListItem[],
    activeFilters: PickupFilters,
    activeSortField: PickupSortField,
    activeSortDirection: PickupSortDirection,
  ) {
    const search = normalizeText(activeFilters.search);

    const filtered = sourceItems.filter((item) => {
      if (search) {
        const haystack = normalizeText([item.full_name, item.cpf, item.phone].join(" "));
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

    const response = await listPickupParticipantsAction({ eventId });

    setLoading(false);

    if (!response.success) {
      setItems([]);
      setVisibleItems([]);
      setMessage(response.message ?? "Não foi possível carregar a lista.");
      return;
    }

    const loadedItems = response.participants;
    setItems(loadedItems);
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
    void (async () => {
      const [capabilityResponse, eventsResponse] = await Promise.all([
        getRetiradaCapabilitiesAction(),
        getPickupEventsAction(),
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

      const preferredEvent =
        (filters.eventId && loadedEvents.find((event) => event.id === filters.eventId)) ??
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
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    window.localStorage.setItem(
      VIEW_STATE_STORAGE_KEY,
      JSON.stringify({
        filters,
        appliedFilters,
        sortField,
        sortDirection,
      }),
    );
  }, [filters, appliedFilters, sortField, sortDirection]);

  async function toggleDetails(participantId: string) {
    if (expandedId === participantId) {
      setExpandedId(null);
      return;
    }

    setExpandedId(participantId);

    if (details[participantId]) return;

    setActionId(participantId);
    const response = await getPickupParticipantDetailsAction(participantId);
    setActionId(null);

    if (!response.success || !response.participant) {
      setMessage(response.message ?? "Não foi possível carregar os detalhes.");
      return;
    }

    setDetails((current) => ({
      ...current,
      [participantId]: response.participant as PickupDetails,
    }));
  }

  async function refreshParticipant(participantId: string) {
    const response = await getPickupParticipantDetailsAction(participantId);

    if (!response.success || !response.participant) return;

    const participant = response.participant as PickupDetails;
    const row = detailToListItem(participant);

    setDetails((current) => ({
      ...current,
      [participantId]: participant,
    }));

    setItems((current) => current.map((item) => (item.id === participantId ? row : item)));
    setVisibleItems((current) => current.map((item) => (item.id === participantId ? row : item)));
  }

  async function runAction(
    participantId: string,
    action: () => Promise<{ success: boolean; message?: string }>,
  ) {
    setActionId(participantId);
    setMessage(null);

    try {
      const response = await action();
      setMessage(response.message ?? (response.success ? "Operação concluída." : "Operação não concluída."));

      if (response.success) {
        await refreshParticipant(participantId);
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Falha inesperada.");
    } finally {
      setActionId(null);
    }
  }

  async function handleQrRead(value: string) {
    setMessage(null);
    const response = await searchPickupParticipantByQrAction(value);

    if (!response.success || !response.participant) {
      setMessage(response.message ?? "Participante não encontrado.");
      return;
    }

    const participant = response.participant as PickupDetails;

    if (participant.event_id !== selectedEvent?.id) {
      setMessage("Participante encontrado em outro evento. Selecione o evento correspondente para operar.");
      return;
    }

    const row = detailToListItem(participant);

    setShowScanner(false);
    setDetails((current) => ({ ...current, [participant.id]: participant }));
    setExpandedId(participant.id);

    setItems((current) => {
      if (current.some((item) => item.id === participant.id)) {
        return current.map((item) => (item.id === participant.id ? row : item));
      }
      return [row, ...current];
    });

    setVisibleItems((current) => {
      if (current.some((item) => item.id === participant.id)) {
        return current.map((item) => (item.id === participant.id ? row : item));
      }
      return [row, ...current];
    });

    window.setTimeout(() => {
      document.getElementById(`participant-${participant.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    }, 150);
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

  function handleApplyFilters() {
    setAppliedFilters(filters);
    applyView(items, filters, sortField, sortDirection);
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

  async function handleRefreshList() {
    if (!selectedEvent?.id) return;
    await loadList(selectedEvent.id, true);
  }

  async function handleDeliverFullKit(participantId: string) {
    await runAction(participantId, () =>
      deliverFullKitAction({ participant_id: participantId }),
    );
  }

  async function handleDeliverKitAndCheckin(participantId: string) {
    await runAction(participantId, () =>
      deliverKitAndCheckinAction({ participant_id: participantId }),
    );
  }

  async function handleCheckin(participantId: string) {
    await runAction(participantId, () =>
      checkinEntryAction({ participant_id: participantId }),
    );
  }

  async function handleDeliverKitItem(participantId: string, kitItemId: string) {
    await runAction(participantId, () =>
      deliverKitItemAction({
        participant_id: participantId,
        kit_item_id: kitItemId,
      }),
    );
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      {showScanner ? (
        <QrScannerModal
          onClose={() => setShowScanner(false)}
          onRead={handleQrRead}
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
            <OperationsFilters
              filters={filters}
              events={events}
              selectedEvent={selectedEvent}
              shirtTypes={shirtTypes}
              shirtSizes={shirtSizes}
              categories={categories}
              cities={cities}
              loading={loading}
              itemCount={visibleItems.length}
              onEventChange={(eventId) => {
                void handleEventChange(eventId);
              }}
              onFilterChange={handleFilterChange}
              onApplyFilters={handleApplyFilters}
              onClearFilters={handleClearFilters}
              onOpenScanner={() => setShowScanner(true)}
              onRefreshList={() => {
                void handleRefreshList();
              }}
            />

            <OperationsDashboard message={message}>
              <OperationsTable
                selectedEvent={selectedEvent}
                items={visibleItems}
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
              />
            </OperationsDashboard>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
