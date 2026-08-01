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
  kit_status: 'none' | 'pending' | 'partial' | 'delivered';
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

export type PickupListItem = {
  id: string;
  event_id: string;
  full_name: string;
  cpf: string;
  phone: string;
  city: string;
  gender: string | null;
  birth_date: string | null;
  payment_status: string;
  payment_method: string;
  registration_status: string;
  shirt_type: string;
  shirt_size: string;
  category_name: string;
  event_name: string;
  ticket_id: string | null;
  ticket_status: string | null;
  ticket_used_at: string | null;
  kit_status: 'none' | 'pending' | 'partial' | 'delivered';
  checkin_status: 'pending' | 'done';
  can_operate: boolean;
  block_reason: string | null;
  event_has_kit: boolean;
  event_has_shirt: boolean;
  event_wristband_enabled: boolean;
  event_wristband_required_for_kit: boolean;
  event_wristband_required_for_checkin: boolean;
  wristband: PickupWristband;
};

export type PickupDetails = PickupListItem & {
  event_kit_enabled: boolean;
  ticket_token: string | null;
  last_checkin_at: string | null;
  last_checkin_actor: string | null;
  all_kit_delivered: boolean;
  allow_checkin_during_kit_delivery: boolean;
  kit_items: Array<{
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
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
};

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
};

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
