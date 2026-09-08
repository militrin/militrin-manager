export type DataDeletionRequestInput = {
  fullName: string;
  email: string;
  instagramHandle?: string;
  notes?: string;
  confirmed: boolean;
  website?: string;
};

export type NormalizedDataDeletionRequest = {
  fullName: string;
  email: string;
  instagramHandle: string | null;
  notes: string | null;
  confirmed: boolean;
  website: string;
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INSTAGRAM_HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

export function normalizeDataDeletionRequest(input: DataDeletionRequestInput): NormalizedDataDeletionRequest {
  const instagramHandle = (input.instagramHandle ?? '').trim().replace(/^@+/, '');
  const notes = (input.notes ?? '').trim();

  return {
    fullName: (input.fullName ?? '').trim().replace(/\s+/g, ' '),
    email: (input.email ?? '').trim().toLowerCase(),
    instagramHandle: instagramHandle || null,
    notes: notes || null,
    confirmed: Boolean(input.confirmed),
    website: (input.website ?? '').trim(),
  };
}

export function validateDataDeletionRequest(input: DataDeletionRequestInput): string | null {
  const normalized = normalizeDataDeletionRequest(input);

  if (normalized.fullName.length < 2 || normalized.fullName.length > 120) {
    return 'Informe seu nome completo.';
  }
  if (!EMAIL_PATTERN.test(normalized.email) || normalized.email.length > 254) {
    return 'Informe um e-mail válido.';
  }
  if (normalized.instagramHandle && !INSTAGRAM_HANDLE_PATTERN.test(normalized.instagramHandle)) {
    return 'Informe um usuário do Instagram válido, ou deixe o campo em branco.';
  }
  if (normalized.notes && normalized.notes.length > 2000) {
    return 'As observações podem ter no máximo 2000 caracteres.';
  }
  if (!normalized.confirmed) {
    return 'Confirme que deseja solicitar a exclusão dos dados.';
  }

  return null;
}
