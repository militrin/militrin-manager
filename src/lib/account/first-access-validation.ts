import { isValidCpf } from '../imports/import-row-validation.ts';
import { parseDateInput } from '../utils/date.ts';

export const FIRST_ACCESS_PROFILE_FIELDS = [
  'full_name',
  'cpf',
  'birth_date',
  'gender',
  'phone',
  'email',
  'city',
] as const;

export const FIRST_ACCESS_GENDERS = ['male', 'female', 'other', 'prefer_not_to_say'] as const;

export type FirstAccessProfileField = (typeof FIRST_ACCESS_PROFILE_FIELDS)[number];
export type FirstAccessFieldErrors = Partial<Record<FirstAccessProfileField, string>>;

export type FirstAccessProfileInput = {
  full_name?: unknown;
  cpf?: unknown;
  birth_date?: unknown;
  gender?: unknown;
  phone?: unknown;
  email?: unknown;
  city?: unknown;
};

export type NormalizedFirstAccessProfile = Record<FirstAccessProfileField, string>;

function normalizeDate(value: unknown) {
  const input = String(value ?? '').trim();
  const date = parseDateInput(input);
  if (!date || !/^(?:\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})$/.test(input)) return '';
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  if (date.getTime() > today.getTime()) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function validateFirstAccessProfile(input: FirstAccessProfileInput) {
  const values: NormalizedFirstAccessProfile = {
    full_name: String(input.full_name ?? '').trim().replace(/\s+/g, ' '),
    cpf: String(input.cpf ?? '').replace(/\D/g, ''),
    birth_date: normalizeDate(input.birth_date),
    gender: String(input.gender ?? '').trim().toLowerCase(),
    phone: String(input.phone ?? '').replace(/\D/g, ''),
    email: String(input.email ?? '').trim().toLowerCase(),
    city: String(input.city ?? '').trim().replace(/\s+/g, ' '),
  };
  const fieldErrors: FirstAccessFieldErrors = {};

  if (values.full_name.length < 3) fieldErrors.full_name = 'Informe seu nome completo.';
  if (!isValidCpf(values.cpf)) fieldErrors.cpf = 'Informe um CPF válido.';
  if (!values.birth_date) fieldErrors.birth_date = 'Informe uma data de nascimento válida.';
  if (!FIRST_ACCESS_GENDERS.includes(values.gender as (typeof FIRST_ACCESS_GENDERS)[number])) {
    fieldErrors.gender = 'Selecione uma opção de gênero.';
  }
  if (values.phone.length < 10 || values.phone.length > 11) fieldErrors.phone = 'Informe um telefone válido com DDD.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) fieldErrors.email = 'O e-mail confirmado da conta é inválido.';
  if (!values.city) fieldErrors.city = 'Informe sua cidade.';

  return {
    success: Object.keys(fieldErrors).length === 0,
    values,
    fieldErrors,
  };
}
