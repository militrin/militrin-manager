"use client";

import type { PickupEvent, PickupFilters } from "../types";

type OperationsFiltersProps = {
  filters: PickupFilters;
  events: PickupEvent[];
  selectedEvent: PickupEvent | null;
  shirtTypes: string[];
  shirtSizes: string[];
  categories: string[];
  cities: string[];
  loading: boolean;
  itemCount: number;
  onEventChange: (eventId: string) => void;
  onFilterChange: <K extends keyof PickupFilters>(key: K, value: PickupFilters[K]) => void;
  onApplyFilters: () => void;
  onClearFilters: () => void;
  onOpenScanner: () => void;
  onRefreshList: () => void;
};

export function OperationsFilters({
  filters,
  events,
  selectedEvent,
  shirtTypes,
  shirtSizes,
  categories,
  cities,
  loading,
  itemCount,
  onEventChange,
  onFilterChange,
  onApplyFilters,
  onClearFilters,
  onOpenScanner,
  onRefreshList,
}: OperationsFiltersProps) {
  const selectClass = "h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-200";

  return (
    <>
      <div className="mb-3 grid gap-2 lg:grid-cols-[minmax(230px,360px)_1fr]">
        <select
          value={filters.eventId}
          onChange={(event) => onEventChange(event.target.value)}
          className={selectClass}
        >
          {events.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
              {item.is_active ? " — ativo" : ""}
            </option>
          ))}
        </select>

        <div className="flex items-center text-xs text-slate-400">
          {selectedEvent?.has_kit
            ? selectedEvent.has_shirt
              ? "Evento com kit e camiseta"
              : "Evento com kit, sem camiseta"
            : "Evento somente com check-in"}
        </div>
      </div>

      <div className="grid gap-2 lg:grid-cols-[minmax(280px,1.45fr)_repeat(5,minmax(120px,1fr))]">
        <input
          value={filters.search}
          onChange={(event) => onFilterChange("search", event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onApplyFilters();
          }}
          placeholder="Nome, CPF ou telefone"
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs"
        />

        <select
          value={filters.category}
          onChange={(event) => onFilterChange("category", event.target.value)}
          className={selectClass}
        >
          <option value="all">Categoria: todas</option>
          {categories.map((category) => (
            <option key={category} value={category}>
              {category}
            </option>
          ))}
        </select>

        <select
          value={filters.city}
          onChange={(event) => onFilterChange("city", event.target.value)}
          className={selectClass}
        >
          <option value="all">Cidade: todas</option>
          {cities.map((city) => (
            <option key={city} value={city}>
              {city}
            </option>
          ))}
        </select>

        <select
          value={filters.gender}
          onChange={(event) => onFilterChange("gender", event.target.value)}
          className={selectClass}
        >
          <option value="all">Todos os gêneros</option>
          <option value="male">Masculino</option>
          <option value="female">Feminino</option>
          <option value="not_informed">Não informado</option>
        </select>

        <select
          value={filters.ageGroup}
          onChange={(event) => onFilterChange("ageGroup", event.target.value)}
          className={selectClass}
        >
          <option value="all">Faixa etária: todas</option>
          <option value="lt18">Até 17</option>
          <option value="18to29">18 a 29</option>
          <option value="30to39">30 a 39</option>
          <option value="40to49">40 a 49</option>
          <option value="50plus">50+</option>
        </select>

        <select
          value={filters.paymentStatus}
          onChange={(event) => onFilterChange("paymentStatus", event.target.value)}
          className={selectClass}
        >
          <option value="all">Pagamento: todos</option>
          <option value="paid">Confirmados</option>
          <option value="pending">Pendentes</option>
        </select>

        <select
          value={filters.kitStatus}
          onChange={(event) => onFilterChange("kitStatus", event.target.value)}
          className={selectClass}
        >
          <option value="all">Kit: todos</option>
          <option value="pending">Pendente</option>
          <option value="partial">Parcial</option>
          <option value="delivered">Entregue</option>
          <option value="none">Sem kit</option>
        </select>

        <select
          value={filters.checkinStatus}
          onChange={(event) => onFilterChange("checkinStatus", event.target.value)}
          className={selectClass}
        >
          <option value="all">Check-in: todos</option>
          <option value="pending">Pendente</option>
          <option value="done">Realizado</option>
        </select>

      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-[repeat(4,minmax(120px,1fr))_minmax(260px,1.2fr)]">
        {selectedEvent?.wristband_enabled ? (
          <select
            value={filters.wristbandStatus}
            onChange={(event) => onFilterChange("wristbandStatus", event.target.value)}
            className={selectClass}
          >
            <option value="all">Pulseira: todas</option>
            <option value="active">Vinculada</option>
            <option value="pending">Sem pulseira</option>
          </select>
        ) : null}

        {selectedEvent?.has_shirt ? (
          <>
            <select
              value={filters.shirtType}
              onChange={(event) => onFilterChange("shirtType", event.target.value)}
              className={selectClass}
            >
              <option value="all">Todas as camisetas</option>
              {shirtTypes.map((shirtType) => (
                <option key={shirtType} value={shirtType}>
                  {shirtType}
                </option>
              ))}
            </select>

            <select
              value={filters.shirtSize}
              onChange={(event) => onFilterChange("shirtSize", event.target.value)}
              className={selectClass}
            >
              <option value="all">Todos os tamanhos</option>
              {shirtSizes.map((shirtSize) => (
                <option key={shirtSize} value={shirtSize}>
                  {shirtSize}
                </option>
              ))}
            </select>
          </>
        ) : null}

        <div className="flex flex-wrap items-center justify-start gap-2 lg:justify-end">
          <button
            type="button"
            onClick={onApplyFilters}
            disabled={loading}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 disabled:opacity-50"
          >
            {loading ? "Carregando..." : "Aplicar"}
          </button>

          <button
            type="button"
            onClick={onClearFilters}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs"
          >
            Limpar
          </button>

          <button
            type="button"
            onClick={onOpenScanner}
            className="rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-cyan-950"
          >
            Ler QR
          </button>

          <button
            type="button"
            onClick={onRefreshList}
            disabled={loading}
            className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Atualizar
          </button>
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={filters.onlyPending}
            onChange={(event) => onFilterChange("onlyPending", event.target.checked)}
            className="h-4 w-4"
          />
          Somente pendências
        </label>

        <div className="ml-auto self-center text-xs text-slate-400">{itemCount} participante(s)</div>
      </div>
    </>
  );
}
