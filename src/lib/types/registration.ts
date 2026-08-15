export type Participant = {
  id: string;
  full_name: string;
  cpf: string;
  birth_date: string;
  gender?: string | null;
  phone: string;
  email: string;
  city?: string | null;
  shirt_type: string;
  shirt_size: string;
  registration_status: string;
  notes?: string | null;
  /** Derivado de event_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Payment = {
  id: string;
  participant_id: string;
  event_id?: string | null;
  order_id?: string | null;
  amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method?: string | null;
  payment_status: string;
  /** Derivado de order_id > event_id > participant_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  pix_code?: string | null;
  pix_qrcode?: string | null;
  gateway_payment_id?: string | null;
  expires_at?: string | null;
  paid_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Order = {
  id: string;
  user_id: string;
  participant_id: string;
  event_id: string;
  order_number: string;
  status: string;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  /** Derivado de event_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  confirmed_at?: string | null;
  cancelled_at?: string | null;
  created_at?: string;
};

export type Ticket = {
  id: string;
  order_id: string;
  participant_id: string | null;
  event_id: string;
  token: string;
  status: string;
  ownership_status: string;
  /** Derivado de order_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  issued_at: string;
  used_at?: string | null;
  cancelled_at?: string | null;
  order_item_id?: string | null;
};

export type ShirtInventory = {
  id: string;
  event_id?: string | null;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  /** Derivado de event_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type Wristband = {
  id: string;
  event_id: string;
  ticket_id: string;
  participant_id: string | null;
  code: string;
  status: 'active' | 'blocked' | 'lost' | 'replaced' | 'unlinked';
  /** Derivado de ticket_id — nunca enviado pelo cliente. */
  organization_id?: string | null;
  linked_at: string;
  linked_by?: string | null;
  unlinked_at?: string | null;
  unlinked_by?: string | null;
  replaced_by_wristband_id?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type RegistrationFormData = {
  full_name: string;
  cpf: string;
  birth_date: string;
  gender: string;
  phone: string;
  email: string;
  city: string;
  shirt_type: string;
  shirt_size: string;
  payment_method: string;
  payment_status: string;
  coupon_code: string;
  notes: string;
};
