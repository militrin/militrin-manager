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
  created_at?: string;
  updated_at?: string;
};

export type Payment = {
  id: string;
  participant_id: string;
  amount: number;
  payment_method?: string | null;
  payment_status: string;
  paid_at?: string | null;
  created_at?: string;
};

export type ShirtInventory = {
  id: string;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
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
