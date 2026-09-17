import { classifyImportedCpf, type CpfCellKind } from './cpf-excel.ts';
import type { ImportDataIssue } from './import-row-validation.ts';
import { isValidCpf } from './import-row-validation.ts';
import {
  calculateAgeAtEventDate,
  isPlausiblePersonAge,
  MIN_PLAUSIBLE_PERSON_AGE_YEARS,
} from '../utils/date.ts';

const CADASTRAL_NO_TICKET_BLOCK = {
  blocks_payment: false,
  blocks_ticket_issuance: false,
  blocks_checkin: false,
  blocks_kit_delivery: false,
} as const;

const BIRTH_DATE_OMIT_TYPES = new Set([
  'missing_required_age',
  'invalid_date',
  'implausible_birth_date',
]);

export function cadastralUserIssue(
  fieldCode: string,
  issueType: string,
  message: string,
): ImportDataIssue {
  return {
    field_code: fieldCode,
    issue_type: issueType,
    message,
    resolution_scope: 'user_resolvable',
    ...CADASTRAL_NO_TICKET_BLOCK,
  };
}

export function classifyLegacyImportBirthDateIssue(input: {
  birthDateInput: string | null | undefined;
  birthDate: string | null | undefined;
  eventStartsAt: string | null | undefined;
  minAge: number;
}): ImportDataIssue | null {
  const birthDateInput = String(input.birthDateInput ?? '').trim();
  const birthDate = String(input.birthDate ?? '').trim() || null;
  const eventStartsAt = input.eventStartsAt ?? null;
  const minAge = Number(input.minAge ?? 0);

  if (!birthDateInput) {
    return cadastralUserIssue(
      'birth_date',
      'missing_required_age',
      'Data de nascimento obrigatoria ausente. Cadastro incompleto; o ingresso legado pode ser emitido.',
    );
  }
  if (!birthDate) {
    return cadastralUserIssue(
      'birth_date',
      'invalid_date',
      'Data de nascimento invalida. Cadastro incompleto; o ingresso legado pode ser emitido.',
    );
  }
  if (minAge > 0 && !eventStartsAt) {
    return {
      field_code: 'event_date',
      issue_type: 'missing_required_for_age',
      message: 'Evento sem data de inicio para validar maioridade.',
      resolution_scope: 'admin_only',
      ...CADASTRAL_NO_TICKET_BLOCK,
    };
  }
  if (!eventStartsAt) return null;

  const ageAtEvent = calculateAgeAtEventDate(birthDate, eventStartsAt);
  if (ageAtEvent === null) {
    return cadastralUserIssue(
      'birth_date',
      'invalid_date',
      'Nascimento invalido ou posterior a data do evento. Cadastro incompleto; o ingresso legado pode ser emitido.',
    );
  }
  if (!isPlausiblePersonAge(ageAtEvent)) {
    return cadastralUserIssue(
      'birth_date',
      'implausible_birth_date',
      `Data de nascimento importada e evidentemente invalida (idade aparente ${ageAtEvent} ano(s), abaixo de ${MIN_PLAUSIBLE_PERSON_AGE_YEARS}). Nao interpretada como menor de idade. Corrija no primeiro acesso.`,
    );
  }
  if (minAge > 0 && ageAtEvent < minAge) {
    return {
      field_code: 'birth_date',
      issue_type: 'underage_at_event',
      message: `Pessoa menor de ${minAge} anos na data do evento. Ingresso legado pode ser emitido; a regra de idade vale no primeiro acesso com DOB valida.`,
      resolution_scope: 'admin_only',
      blocks_payment: false,
      blocks_ticket_issuance: false,
      blocks_checkin: true,
      blocks_kit_delivery: false,
    };
  }
  return null;
}

export function collectLegacyImportPersonalIssues(input: {
  cpfInput: string | null | undefined;
  cpfCellKind?: CpfCellKind;
  emailInput?: string | null;
  email?: string | null;
  phoneInput?: string | null;
  phone?: string | null;
  birthDateInput: string | null | undefined;
  birthDate: string | null | undefined;
  eventStartsAt: string | null | undefined;
  minAge: number;
}): ImportDataIssue[] {
  const issues: ImportDataIssue[] = [];
  const cpfClass = classifyImportedCpf(input.cpfInput, input.cpfCellKind);

  if (cpfClass.kind === 'missing') {
    issues.push(cadastralUserIssue(
      'cpf',
      'missing_required_identity',
      'CPF obrigatorio ausente. Compra preservada com identidade pendente.',
    ));
  } else if (cpfClass.kind === 'excel_leading_zero') {
    issues.push(cadastralUserIssue(
      'cpf',
      'excel_leading_zero',
      'Possivel zero inicial removido pelo Excel. CPF nao sera inventado; identidade fica pendente.',
    ));
  } else if (cpfClass.kind === 'invalid' || !isValidCpf(input.cpfInput)) {
    issues.push(cadastralUserIssue(
      'cpf',
      'invalid_identity',
      'CPF invalido. Compra preservada com identidade pendente.',
    ));
  }

  if (input.emailInput && !input.email) {
    issues.push(cadastralUserIssue('email', 'invalid_format', 'E-mail informado e invalido.'));
  }
  if (input.phoneInput && (!input.phone || input.phone.length < 10 || input.phone.length > 11)) {
    issues.push(cadastralUserIssue('phone', 'invalid_format', 'Telefone informado e invalido.'));
  }

  const birthIssue = classifyLegacyImportBirthDateIssue({
    birthDateInput: input.birthDateInput,
    birthDate: input.birthDate,
    eventStartsAt: input.eventStartsAt,
    minAge: input.minAge,
  });
  if (birthIssue) issues.push(birthIssue);
  return issues;
}

export function shouldPersistImportedBirthDate(
  issues: ImportDataIssue[],
  birthDate: string | null | undefined,
) {
  const omit = issues.some((issue) =>
    issue.field_code === 'birth_date' && BIRTH_DATE_OMIT_TYPES.has(issue.issue_type),
  );
  if (omit) return null;
  return String(birthDate ?? '').trim() || null;
}

export function isCadastralQualityIssue(issue: ImportDataIssue) {
  return ['cpf', 'birth_date', 'email', 'phone', 'city', 'full_name'].includes(issue.field_code)
    && !issue.blocks_payment
    && !issue.blocks_ticket_issuance;
}

export function isCommercialIssuanceIssue(issue: ImportDataIssue) {
  return Boolean(issue.blocks_ticket_issuance || issue.blocks_payment);
}

export function isIdentityClaimReviewReason(reason: string | null | undefined) {
  return [
    'excel_leading_zero',
    'excel_leading_zero_collision',
    'strong_identifier_conflict',
    'name_only_suggestion',
    'possible_reimport',
  ].includes(String(reason ?? ''));
}
