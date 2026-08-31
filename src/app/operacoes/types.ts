import type { OperationalProductItem } from "@/lib/operations/operational-product-item";

/** Shape comum devolvido pelos handlers de acao (page.tsx, via runAction) --
 * usado pelos componentes pra decidir se abrem o modal obrigatorio de
 * pulseira (code === 'WRISTBAND_REQUIRED') sem precisar conhecer o formato
 * exato de cada server action. */
export type ActionResult = { success: boolean; message?: string; code?: string } | void;

export type ReasonPayload = { reasonCode: string; reasonText: string; alsoUnlinkWristband: boolean };

export type OperationMode = 'kit' | 'checkin' | 'both';
export type SortField =
  | 'name'
  | 'city'
  | 'gender'
  | 'age'
  | 'shirt_type'
  | 'shirt_size'
  | 'payment'
  | 'kit'
  | 'checkin'
  | 'wristband';
export type SortDirection = 'asc' | 'desc';

export type OperationEvent = {
  id: string;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  has_kit: boolean;
  has_shirt: boolean;
  wristband_enabled: boolean;
  wristband_required_for_kit: boolean;
  wristband_required_for_checkin: boolean;
};

export type OperationCapabilities = {
  canDeliverKit: boolean;
  canUndoKit: boolean;
  canCheckin: boolean;
  canUndoCheckin: boolean;
  canChangeShirt: boolean;
  canViewWristband: boolean;
  canLinkWristband: boolean;
  canUnlinkWristband: boolean;
  canReplaceWristband: boolean;
  canBlockWristband: boolean;
};

export type WristbandSummary = {
  id: string;
  code: string;
  status: string;
  linked_at: string | null;
};

export type KitItemSummary = {
  kit_item_id: string;
  item_name: string;
  item_type: string;
  quantity: number;
  status: string;
  delivered_at: string | null;
};

export type PurchaseTicketSummary = {
  ticket_id: string;
  participant_id: string | null;
  holder_name: string;
  category_name: string;
  shirt_type: string;
  shirt_size: string;
  ticket_status: string;
  wristband: WristbandSummary | null;
};

export type OperationRow = {
  ticket_id: string;
  ticket_token: string | null;
  ticket_status: string;
  ticket_used_at: string | null;
  participant_id: string | null;
  event_id: string;
  event_name: string;
  order_id: string | null;
  order_number: string | null;
  full_name: string;
  cpf: string;
  phone: string;
  city: string;
  gender: string;
  birth_date: string | null;
  age: number | null;
  category_name: string;
  shirt_type: string;
  shirt_size: string;
  payment_status: string;
  payment_method: string;
  registration_status: string;
  kit_status: 'none' | 'configuration_pending' | 'error' | 'pending' | 'partial' | 'delivered';
  checkin_status: 'pending' | 'done';
  wristband: WristbandSummary | null;
  shirt_available: number | null;
  can_operate: boolean;
  block_reason: string | null;
};

export type OperationDetails = OperationRow & {
  kit_items: KitItemSummary[];
  purchase_tickets: PurchaseTicketSummary[];
  notes: string | null;
  last_checkin_at: string | null;
  last_checkin_actor: string | null;
  shirt_options: Array<{
    shirt_type: string;
    shirt_size: string;
    available: number;
  }>;
};

export type OperationFilters = {
  eventId: string;
  search: string;
  city: string;
  gender: string;
  ageGroup: string;
  paymentStatus: string;
  kitStatus: string;
  checkinStatus: string;
  wristbandStatus: string;
  shirtType: string;
  shirtSize: string;
  onlyPending: boolean;
};

export const EMPTY_OPERATION_FILTERS: OperationFilters = {
  eventId: '',
  search: '',
  city: 'all',
  gender: 'all',
  ageGroup: 'all',
  paymentStatus: 'all',
  kitStatus: 'all',
  checkinStatus: 'all',
  wristbandStatus: 'all',
  shirtType: 'all',
  shirtSize: 'all',
  onlyPending: false,
};

export type PickupEvent = {
  id: string;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  has_kit: boolean;
  has_shirt: boolean;
  wristband_enabled: boolean;
  wristband_required_for_kit: boolean;
  wristband_required_for_checkin: boolean;
};

export type PickupSortField =
  | "name"
  | "city"
  | "gender"
  | "age"
  | "shirt_type"
  | "shirt_size"
  | "payment"
  | "kit"
  | "checkin"
  | "wristband";

export type PickupSortDirection = "asc" | "desc";

export type PickupWristband = {
  id: string;
  code: string;
  status: string;
  linked_at: string | null;
} | null;

type OperationEntryBase = {
  id: string;
  ticket_token: string | null;
  ticket_status: string | null;
  ticket_used_at: string | null;
  ticket_issued_at: string | null;
  participant_id: string | null;
  participant_name: string;
  participant_email: string;
  full_name: string;
  cpf: string;
  phone: string;
  city: string;
  gender: string | null;
  birth_date: string | null;
  registration_status: string;
  event_id: string;
  event_name: string;
  category_id: string | null;
  category_name: string;
  order_id: string | null;
  order_number: string | null;
  order_created_at: string | null;
  buyer_user_id: string | null;
  buyer_name: string;
  buyer_cpf: string;
  buyer_phone: string;
  buyer_email: string;
  buyer_type?: "account" | "imported_holder";
  import_batch_id?: string | null;
  payment_status: string;
  payment_method: string;
  shirt_type: string;
  shirt_size: string;
  kit_status: 'none' | 'configuration_pending' | 'error' | 'pending' | 'partial' | 'delivered';
  checkin_status: 'pending' | 'done';
  wristband_id: string | null;
  wristband_code: string | null;
  wristband_status: string | null;
  can_operate: boolean;
  block_reason: string | null;
  order_ticket_count: number;
  order_ticket_position: number;
  event_has_kit: boolean;
  event_has_shirt: boolean;
  event_wristband_enabled: boolean;
  event_wristband_required_for_kit: boolean;
  event_wristband_required_for_checkin: boolean;
  is_imported_without_ticket: boolean;
  wristband: PickupWristband;
};

export type TicketBackedOperationEntry = OperationEntryBase & {
  kind: "ticket";
  ticket_id: string;
};

export type ParticipantOnlyLegacyOperationEntry = OperationEntryBase & {
  kind: "participant_without_ticket";
  ticket_id: null;
  participant_id: string;
};

export type OperationTicketRow =
  | TicketBackedOperationEntry
  | ParticipantOnlyLegacyOperationEntry;

export type OperationGroup = {
  id: string;
  group_type: "order" | "imported_participant" | "participant";
  order_id: string | null;
  order_number: string | null;
  order_created_at: string | null;
  buyer_user_id: string | null;
  buyer_name: string;
  buyer_cpf: string;
  buyer_phone: string;
  buyer_email: string;
  participant_id: string | null;
  participant_name: string;
  ticket_count: number;
  pending_count: number;
  completed_count: number;
  is_imported_without_ticket: boolean;
  tickets: OperationTicketRow[];
};

export type OperationOrderTicketSummary = {
  ticket_id: string;
  ticket_token: string | null;
  ticket_status: string;
  participant_id: string | null;
  participant_name: string;
  category_name: string;
  shirt_type: string;
  shirt_size: string;
  wristband_code: string | null;
  wristband_status: string | null;
};

export type OperationTicketDetails = TicketBackedOperationEntry & {
  event_kit_enabled: boolean;
  last_checkin_at: string | null;
  last_checkin_actor: string | null;
  all_kit_delivered: boolean;
  allow_checkin_during_kit_delivery: boolean;
  issues: Array<{
    id: string;
    field_code: string;
    issue_type: string;
    message: string;
    blocks_payment: boolean;
    blocks_ticket_issuance: boolean;
    blocks_checkin: boolean;
    blocks_kit_delivery: boolean;
  }>;
  shirt_options: Array<{ type: string; sizes: string[] }>;
  shirt_stock: {
    shirt_type: string;
    shirt_size: string;
    supply_mode: string;
    physical_available: number | null;
    status: "available" | "last_unit" | "out_of_stock" | "not_applicable";
  } | null;
  can_finalize_ticket: boolean;
  can_issue_ticket: boolean;
  registration_contact_pin: string | null;
  order_tickets: OperationOrderTicketSummary[];
  kit_items: Array<{
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
    delivered_by: string | null;
    shirt_type: string | null;
    shirt_size: string | null;
    physical_available: number | null;
    stock_status: "available" | "last_unit" | "out_of_stock" | "not_applicable";
  }>;
  purchase_tickets: Array<{
    ticket_id: string;
    ticket_status: string;
    participant_id: string | null;
    holder_name: string;
    shirt_type: string;
    shirt_size: string;
    category_name: string;
  }>;
  additional_items: AdditionalItem[];
};

export type OperationParticipantDetails = ParticipantOnlyLegacyOperationEntry & {
  origin: "import" | "registration";
  without_ticket_class: "data_pending_import" | "legacy_unresolved" | "regularizable" | "manual_review";
  organization_id: string;
  payment_id: string | null;
  can_finalize_ticket: boolean;
  can_issue_ticket: boolean;
  registration_contact_pin: string | null;
  import_batch_ids: string[];
  issues: Array<{
    id: string;
    field_code: string;
    issue_type: string;
    message: string;
    blocks_payment: boolean;
    blocks_ticket_issuance: boolean;
    blocks_checkin: boolean;
    blocks_kit_delivery: boolean;
  }>;
  shirt_options: Array<{ type: string; sizes: string[] }>;
  legacy_kit_items: Array<{
    id: string;
    item_name: string;
    status: string;
    delivered_at: string | null;
    legacy_unresolved: boolean;
  }>;
  no_ticket_reason: string;
  can_regularize_ticket: boolean;
  regularization_reason: string;
  regularization_blockers: string[];
  batch_id: string | null;
  event_categories: Array<{ id: string; name: string }>;
  event_batches: Array<{ id: string; name: string }>;
};

export type PickupListItem = OperationTicketRow;

export type PickupDetails = OperationTicketDetails | OperationParticipantDetails;

export type PickupListGroup = OperationGroup;

export type PickupFilters = {
  eventId: string;
  search: string;
  category: string;
  city: string;
  gender: string;
  ageGroup: string;
  paymentStatus: string;
  kitStatus: string;
  checkinStatus: string;
  wristbandStatus: string;
  shirtType: string;
  shirtSize: string;
  onlyPending: boolean;
};

export type PickupCapabilities = {
  canDeliverKit: boolean;
  canCheckin: boolean;
  canCombined: boolean;
  canChangeShirt: boolean;
  canUndoKit: boolean;
  canUndoCheckin: boolean;
  canViewWristband: boolean;
  canLinkWristband: boolean;
  canUnlinkWristband: boolean;
  canReplaceWristband: boolean;
  canGrantStoreItems: boolean;
  canDeliverStoreItems: boolean;
};

// Itens adicionais (loja) concedidos/comprados por um participante -- NUNCA
// somados ao kit do ingresso. "origin" distingue quem colocou o item ali:
// autoatendimento na loja/compre-junto ("loja") ou concessao administrativa
// ("admin"); "codigo" fica reservado para quando code_required for
// implementado.
export type AdditionalItem = {
  id: string;
  store_item_id: string;
  store_item_name: string;
  variant_label: string | null;
  quantity: number;
  status: "reserved" | "confirmed" | "delivered" | "cancelled";
  delivered_at: string | null;
  origin: "admin" | "loja" | "codigo";
  is_courtesy: boolean;
};

export const REASON_CODES = [
  'operational_error',
  'wrong_person',
  'accidental_scan',
  'administrative_correction',
  'system_test',
  'other',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export const REASON_CODE_LABELS: Record<ReasonCode, string> = {
  operational_error: 'Erro operacional',
  wrong_person: 'Pessoa errada',
  accidental_scan: 'Leitura acidental',
  administrative_correction: 'Correção administrativa',
  system_test: 'Teste de sistema',
  other: 'Outro',
};

export type WristbandHistoryEntry = {
  id: string;
  action: string;
  code: string | null;
  reason: string | null;
  actor_email: string | null;
  created_at: string;
};

// Produto (Modo Turbo + Central) -- QUALQUER um dos dois canais (loja
// standalone OU "compre junto" no checkout), resolvido pelo MESMO formato
// canonico (OperationalProductItem, src/lib/operations/operational-product-item.ts)
// -- as tabelas continuam separadas, `source`+`item_id`+`order_id` sao
// preservados pra que a entrega saiba em qual dominio atuar, mas a UI nunca
// mais precisa de um "if store_item / else order_item_product" -- so um
// formato so, consumido por uma tela so pra revisao e uma tela so pra
// "ja entregue".
export type { OperationalProductItem } from "@/lib/operations/operational-product-item";

export type TurboScanResult =
  | { success: true; kind: "ticket"; participant: OperationTicketDetails }
  | { success: true; kind: "product"; item: OperationalProductItem }
  | { success: false; message: string };

export const EMPTY_PICKUP_FILTERS: PickupFilters = {
  eventId: '',
  search: '',
  category: 'all',
  city: 'all',
  gender: 'all',
  ageGroup: 'all',
  paymentStatus: 'all',
  kitStatus: 'all',
  checkinStatus: 'all',
  wristbandStatus: 'all',
  shirtType: 'all',
  shirtSize: 'all',
  onlyPending: false,
};
