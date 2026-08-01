"use client";

import { ExpandedParticipantDetails } from "./ExpandedParticipantDetails";
import { OperationRow } from "./OperationRow";
import { getOperationsGridConfig } from "./tableGrid";
import type {
  PickupCapabilities,
  PickupDetails,
  PickupEvent,
  PickupListItem,
  PickupSortDirection,
  PickupSortField,
} from "../types";

const SORT_PRESETS: Array<{ field: PickupSortField; direction: PickupSortDirection; label: string }> = [
  { field: "name", direction: "asc", label: "Nome A-Z" },
  { field: "name", direction: "desc", label: "Nome Z-A" },
  { field: "city", direction: "asc", label: "Cidade A-Z" },
  { field: "city", direction: "desc", label: "Cidade Z-A" },
  { field: "gender", direction: "asc", label: "Gênero A-Z" },
  { field: "gender", direction: "desc", label: "Gênero Z-A" },
  { field: "age", direction: "asc", label: "Idade menor-maior" },
  { field: "age", direction: "desc", label: "Idade maior-menor" },
  { field: "shirt_type", direction: "asc", label: "Camiseta modelo A-Z" },
  { field: "shirt_type", direction: "desc", label: "Camiseta modelo Z-A" },
  { field: "shirt_size", direction: "asc", label: "Tamanho menor-maior" },
  { field: "shirt_size", direction: "desc", label: "Tamanho maior-menor" },
  { field: "payment", direction: "asc", label: "Pagamento (confirmado primeiro)" },
  { field: "payment", direction: "desc", label: "Pagamento (pendente primeiro)" },
  { field: "kit", direction: "asc", label: "Kit (pendente primeiro)" },
  { field: "kit", direction: "desc", label: "Kit (entregue primeiro)" },
  { field: "checkin", direction: "asc", label: "Check-in (pendente primeiro)" },
  { field: "checkin", direction: "desc", label: "Check-in (realizado primeiro)" },
  { field: "wristband", direction: "asc", label: "Pulseira (vinculada primeiro)" },
  { field: "wristband", direction: "desc", label: "Pulseira (pendente primeiro)" },
];

function HeaderButton({
  label,
  field,
  currentField,
  currentDirection,
  onSort,
}: {
  label: string;
  field: PickupSortField;
  currentField: PickupSortField;
  currentDirection: PickupSortDirection;
  onSort: (field: PickupSortField) => void;
}) {
  const active = currentField === field;
  const indicator = active ? (currentDirection === "asc" ? "↑" : "↓") : "";

  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`inline-flex items-center gap-1 text-left transition ${active ? "text-slate-100" : "hover:text-slate-200"}`}
    >
      <span>{label}</span>
      <span>{indicator}</span>
    </button>
  );
}

export function OperationsTable({
  selectedEvent,
  items,
  details,
  expandedId,
  actionId,
  loading,
  capabilities,
  sortField,
  sortDirection,
  onToggleDetails,
  onDeliverFullKit,
  onDeliverKitAndCheckin,
  onCheckin,
  onDeliverKitItem,
  onSort,
  onSortPreset,
}: {
  selectedEvent: PickupEvent | null;
  items: PickupListItem[];
  details: Record<string, PickupDetails>;
  expandedId: string | null;
  actionId: string | null;
  loading: boolean;
  capabilities: PickupCapabilities;
  sortField: PickupSortField;
  sortDirection: PickupSortDirection;
  onToggleDetails: (participantId: string) => Promise<void>;
  onDeliverFullKit: (participantId: string) => Promise<void>;
  onDeliverKitAndCheckin: (participantId: string) => Promise<void>;
  onCheckin: (participantId: string) => Promise<void>;
  onDeliverKitItem: (participantId: string, kitItemId: string) => Promise<void>;
  onSort: (field: PickupSortField) => void;
  onSortPreset: (field: PickupSortField, direction: PickupSortDirection) => void;
}) {
  const grid = getOperationsGridConfig(selectedEvent);
  const activeSortValue = `${sortField}:${sortDirection}`;

  return (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Ordenar por</span>
          <select
            value={activeSortValue}
            onChange={(event) => {
              const [field, direction] = event.target.value.split(":") as [PickupSortField, PickupSortDirection];
              onSortPreset(field, direction);
            }}
            className="h-8 min-w-55 rounded-lg border border-slate-700 bg-slate-950 px-2.5 text-xs text-slate-100"
          >
            {SORT_PRESETS.map((preset) => (
              <option key={`${preset.field}:${preset.direction}`} value={`${preset.field}:${preset.direction}`}>
                {preset.label}
              </option>
            ))}
          </select>
        </div>

        <div className={grid.minWidth}>
          <div
            className={`hidden gap-2 bg-slate-950/80 px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400 lg:grid ${grid.header}`}
          >
            <HeaderButton label="Participante" field="name" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
            <div>Categoria</div>
            {selectedEvent?.has_shirt ? (
              <div className="flex items-center gap-1">
                <HeaderButton label="Camiseta" field="shirt_type" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
                <span className="text-slate-600">/</span>
                <HeaderButton label="Tam." field="shirt_size" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
              </div>
            ) : null}
            <HeaderButton label="Pagamento" field="payment" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
            {selectedEvent?.has_kit ? <HeaderButton label="Kit" field="kit" currentField={sortField} currentDirection={sortDirection} onSort={onSort} /> : null}
            <HeaderButton label="Check-in" field="checkin" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
            {selectedEvent?.wristband_enabled ? (
              <HeaderButton label="Pulseira" field="wristband" currentField={sortField} currentDirection={sortDirection} onSort={onSort} />
            ) : null}
            <div>Ações</div>
          </div>

          {loading && items.length === 0 ? (
            <div className="p-8 text-center text-slate-400">Carregando participantes...</div>
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-slate-400">Nenhum participante encontrado.</div>
          ) : (
            items.map((item) => {
              const isExpanded = expandedId === item.id;
              const detail = details[item.id];
              const busy = actionId === item.id;

              return (
                <div id={`participant-${item.id}`} key={item.id} className="border-t border-slate-800 first:border-t-0">
                  <OperationRow
                    item={item}
                    selectedEvent={selectedEvent}
                    isExpanded={isExpanded}
                    busy={busy}
                    capabilities={capabilities}
                    onToggleDetails={(participantId) => {
                      void onToggleDetails(participantId);
                    }}
                    onDeliverFullKit={onDeliverFullKit}
                    onDeliverKitAndCheckin={onDeliverKitAndCheckin}
                    onCheckin={onCheckin}
                  />

                  {isExpanded ? (
                    <div className="bg-slate-950/55 px-4 py-5">
                      <ExpandedParticipantDetails
                        detail={detail}
                        busy={busy}
                        selectedEvent={selectedEvent}
                        capabilities={capabilities}
                        onDeliverFullKit={onDeliverFullKit}
                        onCheckin={onCheckin}
                        onDeliverKitAndCheckin={onDeliverKitAndCheckin}
                        onDeliverKitItem={onDeliverKitItem}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>
    </>
  );
}
