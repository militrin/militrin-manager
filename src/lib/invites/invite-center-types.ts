import type { InviteCenterStatus } from './invite-center-status';

export type InviteCenterPerson = {
  contact_id: string;
  full_name: string;
  is_principal?: boolean;
  public_pin?: string | null;
  role?: string;
};

export type InviteCenterListRow = {
  row_key: string;
  invite_id: string | null;
  principal_contact_id: string | null;
  email_masked: string;
  principal_name: string | null;
  principal_pin: string | null;
  person_count: number;
  event_id: string | null;
  event_name: string | null;
  ticket_count: number;
  sent_at: string | null;
  invite_created_at: string | null;
  expires_at: string | null;
  claimed_at: string | null;
  status: InviteCenterStatus;
  cadastral_incomplete: boolean;
  auth_linked: boolean;
  owner_materialized: boolean;
  import_batch_id: string | null;
  mixed_intended_owners?: boolean;
  can_resend: boolean;
  people?: InviteCenterPerson[];
};

export type InviteCenterCounts = {
  total: number;
  concluido: number;
  pendente: number;
  expirado: number;
  falha: number;
  cadastro_pendente: number;
  admin_action: number;
  nao_enviado: number;
  pulado: number;
  shared_groups: number;
};

export type InviteCenterJobProgress = {
  id: string;
  status: string;
  total_count: number;
  unique_email_count: number;
  processed_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  last_error_safe?: string | null;
};

export type InviteCenterListPayload = {
  counts: InviteCenterCounts;
  completion: { done: number; total: number; percent: number };
  rows: InviteCenterListRow[];
  page: number;
  page_size: number;
  row_count: number;
  scoped_count?: number;
  sent_last_24h: number;
  bulk_batch_size?: number;
  active_job?: InviteCenterJobProgress | null;
  events: Array<{ id: string; name: string }>;
  import_batches: Array<{ id: string; label: string }>;
};
