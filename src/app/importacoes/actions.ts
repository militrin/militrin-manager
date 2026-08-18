'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getCurrentOrganizationContext } from '@/lib/organizations/current-organization';
import { inferColumnMapping, type CanonicalField } from '@/lib/imports/columns';
import { parseSpreadsheetFile } from '@/lib/imports/parse-file';
import {
  maskCpf,
  removeAccents,
  normalizeCpf,
  normalizeEmail,
  normalizeForMatch,
  normalizePhone,
  parseBrDateToISO,
  removeDuplicateSpaces,
} from '@/lib/imports/normalization';
import {
  isValidCpf,
  normalizeCpfDigits,
  resolveImportOptionWithDefault,
  type ImportDataIssue,
} from '@/lib/imports/import-row-validation';
import { calculateAgeAtEventDate } from '@/lib/utils/date';

const importTypeSchema = z.enum([
  'historical_participations',
  'current_event_registrations',
  'inventory',
  'payments',
]);

const rowResolutionSchema = z.enum(['pending', 'link_existing', 'create_new', 'ignore', 'mark_duplicate']);

type NormalizedRow = {
  full_name: string;
  normalized_name: string;
  cpf: string | null;
  cpf_input: string | null;
  email: string | null;
  email_input: string | null;
  phone: string | null;
  phone_input: string | null;
  birth_date: string | null;
  birth_date_input: string | null;
  gender: string | null;
  city: string | null;
  event_name: string | null;
  event_year: number | null;
  category: string | null;
  batch: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  status: string;
  amount: number | null;
  payment_method: string | null;
  resolved_batch_id: string | null;
  resolved_category_id: string | null;
  resolved_male_price: number | null;
  resolved_female_price: number | null;
  gender_inference: {
    inferred_field: 'gender';
    inferred_value: 'female';
    inference_source: 'shirt_type';
    original_value: string;
  } | null;
};

function normalizeStatus(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['confirmado', 'confirmed', 'pago', 'paid'].includes(normalized)) return 'confirmed';
  if (['cancelado', 'cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  if (['duplicado', 'duplicate'].includes(normalized)) return 'duplicate';
  if (['revisar', 'review_required', 'review'].includes(normalized)) return 'review_required';
  return 'pending';
}

function normalizePaymentMethod(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (['pix', 'credito', 'credit_card', 'cartao', 'card'].includes(normalized)) {
    return normalized === 'pix' ? 'pix' : 'credit_card';
  }
  if (['dinheiro', 'cash'].includes(normalized)) return 'cash';
  if (['cortesia', 'courtesy'].includes(normalized)) return 'courtesy';
  return null;
}

function normalizeImportedGender(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toLowerCase();

  if (!normalized) return null;

  if (["masculino", "male", "m"].includes(normalized)) {
    return "male";
  }

  if (["feminino", "female", "f"].includes(normalized)) {
    return "female";
  }

  return null;
}

function parseAmount(value: string | null | undefined) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\./g, '')
    .replace(',', '.');

  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseImportedBirthDate(value: string | null | undefined) {
  const raw = String(value ?? '').trim();

  if (!raw) return null;

  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const excelSerial = Number(raw);

    if (
      Number.isFinite(excelSerial) &&
      excelSerial > 0 &&
      excelSerial < 100000
    ) {
      const excelEpoch = Date.UTC(1899, 11, 30);
      const milliseconds =
        Math.floor(excelSerial) * 24 * 60 * 60 * 1000;

      return new Date(excelEpoch + milliseconds)
        .toISOString()
        .slice(0, 10);
    }
  }

  return parseBrDateToISO(raw);
}


function normalizeHeaderKey(value: string) {
  return removeAccents(String(value ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function getMappedCell(
  rawRow: Record<string, string>,
  mapping: Partial<Record<CanonicalField, string>>,
  field: CanonicalField,
) {
  const mappedHeader = String(mapping[field] ?? '').trim();

  if (mappedHeader && Object.prototype.hasOwnProperty.call(rawRow, mappedHeader)) {
    return String(rawRow[mappedHeader] ?? '').trim();
  }

  const normalizedMappedHeader = normalizeHeaderKey(mappedHeader);
  if (normalizedMappedHeader) {
    const matchingHeader = Object.keys(rawRow).find(
      (header) => normalizeHeaderKey(header) === normalizedMappedHeader,
    );

    if (matchingHeader) {
      return String(rawRow[matchingHeader] ?? '').trim();
    }
  }

  return '';
}

function normalizeHistoricalEventKey(value: string) {
  return removeDuplicateSpaces(removeAccents(value).toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

function extractEventYearFromLabel(value: string) {
  const match = value.match(/(19|20)\d{2}/);
  return match ? Number(match[0]) : null;
}

function toCanonicalRow(rawRow: Record<string, string>, mapping: Partial<Record<CanonicalField, string>>, fallbackYear: number | null) {
  const get = (field: CanonicalField) => getMappedCell(rawRow, mapping, field);

  const fullName = removeDuplicateSpaces(get('full_name'));
  const rawYear = get('event_year');
  const parsedYear = rawYear ? Number(rawYear) : null;
  const originalShirtType = removeDuplicateSpaces(get('shirt_type'));
  const normalizedShirtKey = removeAccents(originalShirtType).toLowerCase().replace(/\s+/g, ' ').trim();
  const isBabylook = ['babylook', 'baby look', 'feminina', 'feminino'].includes(normalizedShirtKey);
  const isStandardShirt = normalizedShirtKey === 'camiseta';
  const importedGender = normalizeImportedGender(get('gender'));
  const cpfInput = normalizeCpfDigits(get('cpf')) || null;
  const birthDateInput = get('birth_date') || null;
  const emailInput = get('email') || null;
  const phoneInput = get('phone') || null;

  const row: NormalizedRow = {
    full_name: fullName,
    normalized_name: normalizeForMatch(fullName),
    cpf: normalizeCpf(cpfInput),
    cpf_input: cpfInput,
    email: normalizeEmail(emailInput),
    email_input: emailInput,
    phone: normalizePhone(phoneInput),
    phone_input: phoneInput,
    birth_date: parseImportedBirthDate(birthDateInput),
    birth_date_input: birthDateInput,
    gender: isBabylook ? 'female' : importedGender,
    city: removeDuplicateSpaces(get('city')) || null,
    event_name: removeDuplicateSpaces(get('event_name')) || null,
    event_year: Number.isFinite(parsedYear ?? NaN) ? parsedYear : fallbackYear,
    category: removeDuplicateSpaces(get('category')) || null,
    batch: removeDuplicateSpaces(get('batch')) || null,
    shirt_type: isBabylook ? 'Babylook' : isStandardShirt ? 'Camiseta' : originalShirtType || null,
    shirt_size: removeDuplicateSpaces(get('shirt_size')) || null,
    status: normalizeStatus(get('status')),
    amount: parseAmount(get('amount')),
    payment_method: normalizePaymentMethod(get('payment_method')),
    resolved_batch_id: null,
    resolved_category_id: null,
    resolved_male_price: null,
    resolved_female_price: null,
    gender_inference: isBabylook ? {
      inferred_field: 'gender',
      inferred_value: 'female',
      inference_source: 'shirt_type',
      original_value: originalShirtType,
    } : null,
  };

  return row;
}

function isRowReadyToImport(status: string, resolution: string) {
  if (status === 'error') return false;
  if (status === 'duplicate') return resolution === 'create_new';
  if (status === 'review_required') return resolution === 'link_existing' || resolution === 'create_new';
  return true;
}

async function getCurrentEventImportRules(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventId: string | null,
) {
  if (!eventId) return null;

  const [{ data: event }, { data: shirtItems }, { data: batches }, { data: categories }] = await Promise.all([
    supabase.from('events').select('organization_id,starts_at,limit_shirt_selection_to_stock,min_age').eq('id', eventId).maybeSingle(),
    supabase.from('event_kit_items').select('id').eq('event_id', eventId).eq('item_type', 'shirt').eq('is_active', true),
    supabase.from('registration_batches').select('id,name,sequence_number').eq('event_id', eventId).eq('is_active', true),
    supabase.from('ticket_categories').select('id,name').eq('event_id', eventId).eq('is_active', true),
  ]);

  const batchIds = (batches ?? []).map((batch) => String(batch.id));
  const { data: prices } = batchIds.length ? await supabase
    .from('registration_batch_prices')
    .select('batch_id,ticket_category_id,male_price,female_price')
    .in('batch_id', batchIds) : { data: [] };

  const shirtItemIds = (shirtItems ?? []).map((item) => String(item.id));
  // Mesmo par name+value que ensure_ticket_kit_items usa pra resolver a
  // variante na entrega (comparacao exata, sem normalizar caixa) -- validar
  // aqui com a mesma regra evita que uma linha "pronta" na importacao va
  // falhar silenciosamente so no dia do evento.
  const { data: shirtVariantRows } = shirtItemIds.length ? await supabase
    .from('event_kit_item_variants')
    .select('name,value')
    .in('kit_item_id', shirtItemIds)
    .eq('is_active', true) : { data: [] };

  return {
    organizationId: event?.organization_id ? String(event.organization_id) : null,
    genderRequiredForPricing: false,
    eventStartsAt: event?.starts_at ? String(event.starts_at) : null,
    // Mesma configuração canônica usada no checkout público (events.min_age) --
    // nunca um "18" artificial: 0/null aqui significa "sem exigência de idade".
    minAge: Number(event?.min_age ?? 0),
    shirtRequiredBeforeCompletion: false,
    shirtRequiredForImport: Boolean(event?.limit_shirt_selection_to_stock && shirtItems?.length),
    shirtVariantKeys: new Set((shirtVariantRows ?? []).map((variant) => `${String(variant.name).trim()} ${String(variant.value).trim()}`)),
    batches: (batches ?? []).map((batch) => ({
      id: String(batch.id),
      name: String(batch.name),
      sequenceNumber: Number(batch.sequence_number),
    })),
    categories: (categories ?? []).map((category) => ({ id: String(category.id), name: String(category.name) })),
    prices: (prices ?? []).map((price) => ({
      batchId: String(price.batch_id),
      categoryId: String(price.ticket_category_id),
      malePrice: Number(price.male_price),
      femalePrice: Number(price.female_price),
    })),
  };
}

export async function parseImportFileAction(formData: FormData) {
  const file = formData.get('file');
  const importTypeRaw = String(formData.get('import_type') ?? 'historical_participations');
  const importType = importTypeSchema.parse(importTypeRaw);
  const eventIdValue = String(formData.get('event_id') ?? '').trim();
  const eventId = eventIdValue || null;
  const historicalEventName = removeDuplicateSpaces(String(formData.get('historical_event_name') ?? '').trim());
  const historicalEventYearValue = String(formData.get('historical_event_year') ?? '').trim();
  const historicalEventYear = historicalEventYearValue ? Number(historicalEventYearValue) : null;
  const historicalEventKey = historicalEventName ? normalizeHistoricalEventKey(historicalEventName) : null;
  const mappingJson = String(formData.get('mapping_json') ?? '').trim();
  const defaultCategoryId = String(formData.get('default_category_id') ?? '').trim() || null;
  const defaultBatchId = String(formData.get('default_batch_id') ?? '').trim() || null;

  if (!(file instanceof File)) {
    return { success: false as const, message: 'Selecione um arquivo CSV ou XLSX.' };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false as const, message: 'Sessao expirada. Entre novamente.' };
  }
  const currentOrganization = (await getCurrentOrganizationContext()).organization;
  if (!currentOrganization?.id) return { success: false as const, message: 'Selecione uma organizacao para importar.' };

  if (importType === 'current_event_registrations' && !eventId) {
    return { success: false as const, message: 'Selecione explicitamente o evento da importação.' };
  }

  try {
    if (importType === 'current_event_registrations') {
      const { data: selectedEvent, error: selectedEventError } = await supabase
        .from('events').select('id,organization_id,archived_at').eq('id', eventId!).maybeSingle();
      if (selectedEventError || !selectedEvent?.id || selectedEvent.archived_at) {
        return { success: false as const, message: 'Evento selecionado inválido ou indisponível para importação.' };
      }
      if (String(selectedEvent.organization_id) !== currentOrganization.id) {
        return { success: false as const, message: 'Evento selecionado não pertence à organização atual.' };
      }
    }
    const { headers, rows } = await parseSpreadsheetFile(file);
    if (!headers.length || !rows.length) {
      return { success: false as const, message: 'Arquivo vazio ou sem cabecalho valido.' };
    }

    if (importType === 'historical_participations' && !historicalEventName) {
      return { success: false as const, message: 'Informe o nome do evento histórico.' };
    }

    const inferredMapping = inferColumnMapping(headers);
    const customMapping = mappingJson ? JSON.parse(mappingJson) as Partial<Record<CanonicalField, string>> : null;
    const mapping = customMapping && Object.keys(customMapping).length ? customMapping : inferredMapping;

    if (importType === 'current_event_registrations' && eventId) {
      if (defaultCategoryId) {
        const { count } = await supabase.from('ticket_categories').select('id', { count: 'exact', head: true }).eq('id', defaultCategoryId).eq('event_id', eventId).eq('is_active', true);
        if (!count) return { success: false as const, message: 'Categoria padrão inválida para o evento.' };
      }
      if (defaultBatchId) {
        const { count } = await supabase.from('registration_batches').select('id', { count: 'exact', head: true }).eq('id', defaultBatchId).eq('event_id', eventId).eq('is_active', true);
        if (!count) return { success: false as const, message: 'Lote padrão inválido para o evento.' };
      }
      if (defaultCategoryId && defaultBatchId) {
        const { count } = await supabase.from('registration_batch_prices').select('id', { count: 'exact', head: true }).eq('batch_id', defaultBatchId).eq('ticket_category_id', defaultCategoryId);
        if (!count) return { success: false as const, message: 'Categoria e lote padrão não possuem preço compatível.' };
      }
    }

    const cpfs = new Set<string>();
    const emails = new Set<string>();
    const normalizedNames = new Set<string>();

    const normalizedRows = rows.map((rawRow) => {
      const normalized = toCanonicalRow(rawRow, mapping, historicalEventYear);
      if (normalized.cpf) cpfs.add(normalized.cpf);
      if (normalized.email) emails.add(normalized.email);
      if (normalized.normalized_name) normalizedNames.add(normalized.normalized_name);
      return normalized;
    });

    const eventRules = importType === 'current_event_registrations'
      ? await getCurrentEventImportRules(supabase, eventId)
      : null;

    const [{ data: contactsByCpf }, { data: participantsByCpf }, { data: participantsByEmail }, { data: participantsByEvent }, { data: existingHistoricalRows }] = await Promise.all([
      importType === 'current_event_registrations' && cpfs.size && eventRules?.organizationId
        ? supabase.from('registration_contacts').select('id,full_name,cpf,email').eq('organization_id', eventRules.organizationId).in('cpf', Array.from(cpfs))
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      importType === 'historical_participations' && cpfs.size
        ? supabase.from('participants').select('id, full_name, cpf, email, event_id, user_id, registration_contact_id').in('cpf', Array.from(cpfs))
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      importType === 'historical_participations' && emails.size
        ? (() => {
            const query = supabase
              .from('participants')
              .select('id, full_name, cpf, email, event_id, user_id')
              .in('email', Array.from(emails));

            return query;
          })()
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      eventId
        ? supabase
            .from('participants')
            .select('id, full_name, cpf, email, event_id, user_id')
            .eq('event_id', eventId)
            .limit(5000)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      importType === 'historical_participations' && historicalEventKey
        ? supabase
            .from('participation_history')
            .select('id, participant_id, user_id, cpf, email, normalized_name, historical_event_key')
            .eq('historical_event_key', historicalEventKey)
            .limit(10000)
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    ]);

    const cpfMap = new Map<string, Record<string, unknown>>();
    for (const contact of contactsByCpf ?? []) {
      const key = normalizeCpf(String(contact.cpf ?? ''));
      if (key) cpfMap.set(key, contact);
    }
    for (const participant of participantsByCpf ?? []) {
      const key = normalizeCpf(String(participant.cpf ?? ''));
      if (key) cpfMap.set(key, participant);
    }

    const emailMap = new Map<string, Record<string, unknown>>();
    for (const participant of participantsByEmail ?? []) {
      const key = normalizeEmail(String(participant.email ?? ''));
      if (key) emailMap.set(key, participant);
    }

    const normalizedNameMap = new Map<string, Record<string, unknown>>();
    for (const participant of participantsByEvent ?? []) {
      const key = normalizeForMatch(String(participant.full_name ?? ''));
      if (key) normalizedNameMap.set(key, participant);
    }

    // Contatos ja resolvidos (contactsByCpf) que ja possuem order_item vivo
    // NESTE evento -- sem isso, reimportar um arquivo ja processado cria um
    // pedido/pagamento/ingresso novo e "sem titular" a cada execucao, pra
    // cada pessoa, silenciosamente (a checagem de titularidade da RPC so
    // decide QUEM fica titular, nunca impede a criacao do pedido em si).
    const contactIdsAlreadyInEvent = new Set<string>();
    const existingOrderItemByContact = new Map<string, { id: string; shirtType: string | null; shirtSize: string | null }>();
    if (importType === 'current_event_registrations' && eventId && contactsByCpf?.length) {
      const contactIds = contactsByCpf.map((contact) => String(contact.id));
      const { data: existingOrderItems } = await supabase
        .from('order_items')
        .select('id,registration_contact_id,shirt_type,shirt_size')
        .eq('event_id', eventId)
        .in('registration_contact_id', contactIds)
        .not('status', 'in', '(cancelled,expired,refunded)');
      for (const item of existingOrderItems ?? []) {
        if (!item.registration_contact_id) continue;
        const contactId = String(item.registration_contact_id);
        contactIdsAlreadyInEvent.add(contactId);
        if (!existingOrderItemByContact.has(contactId)) {
          existingOrderItemByContact.set(contactId, {
            id: String(item.id),
            shirtType: item.shirt_type ? String(item.shirt_type) : null,
            shirtSize: item.shirt_size ? String(item.shirt_size) : null,
          });
        }
      }
    }
    const shirtConflictsToFlag: Array<{ rowIndex: number; orderItemId: string; existingType: string; existingSize: string; importedType: string; importedSize: string }> = [];

    const historicalIdentitySet = new Set<string>();
    for (const historicalRow of existingHistoricalRows ?? []) {
      const rowCpf = normalizeCpf(String(historicalRow.cpf ?? ''));
      const rowEmail = normalizeEmail(String(historicalRow.email ?? ''));
      const rowName = normalizeForMatch(String(historicalRow.normalized_name ?? ''));
      if (rowCpf) historicalIdentitySet.add(`cpf:${rowCpf}`);
      if (rowEmail) historicalIdentitySet.add(`email:${rowEmail}`);
      if (rowName) historicalIdentitySet.add(`name:${rowName}`);
    }

    const batchInsert = await supabase
      .from('import_batches')
      .insert({
        file_name: file.name,
        import_type: importType,
        event_id: eventId,
        historical_event_label: importType === 'historical_participations' ? historicalEventName : null,
        historical_event_key: importType === 'historical_participations' ? historicalEventKey : null,
        historical_event_year: importType === 'historical_participations'
          ? (historicalEventYear ?? extractEventYearFromLabel(historicalEventName) ?? null)
          : null,
        imported_by: user.id,
        organization_id: currentOrganization.id,
        total_rows: normalizedRows.length,
        status: 'processing',
      })
      .select('id')
      .single();

    if (batchInsert.error || !batchInsert.data?.id) {
      throw new Error(batchInsert.error?.message ?? 'Falha ao criar lote de importacao.');
    }

    const batchId = String(batchInsert.data.id);

    let errorRows = 0;
    let duplicateRows = 0;
    let reviewRows = 0;
    const seenHistoricalIdentityKeys = new Set<string>();
    const seenHistoricalCpfs = new Set<string>();
    const seenCurrentEventCpfs = new Set<string>();

    const rowsToInsert = normalizedRows.map((row, index) => {
      let status = 'ready';
      let resolution = 'pending';
      let errorMessage: string | null = null;
      let matchedParticipantId: string | null = null;
      let matchedRegistrationContactId: string | null = null;
      let matchedUserId: string | null = null;
      const dataIssues: ImportDataIssue[] = [];

      if (!row.full_name) {
        status = 'error';
        errorMessage = 'Nome obrigatorio ausente.';
      }

      if (importType === 'current_event_registrations'
        && status !== 'error'
        && eventRules?.genderRequiredForPricing
        && !row.gender) {
        status = 'data_pending';
        errorMessage = 'Informe o genero para calcular o valor da inscricao.';
        dataIssues.push({
          field_code: 'gender',
          issue_type: 'missing_required_for_pricing',
          message: errorMessage,
          blocks_payment: true,
          blocks_ticket_issuance: true,
          blocks_checkin: false,
          blocks_kit_delivery: false,
        });
      }

      if (importType === 'current_event_registrations'
        && status !== 'error'
        && eventRules?.shirtRequiredBeforeCompletion
        && (!row.shirt_type || !row.shirt_size)) {
        status = 'data_pending';
        const message = 'Modelo e tamanho da camiseta devem ser informados antes da conclusão.';
        errorMessage = errorMessage ? `${errorMessage} ${message}` : message;
        dataIssues.push({
          field_code: 'shirt_selection', issue_type: 'missing_required_for_inventory', message,
          blocks_payment: false, blocks_ticket_issuance: false,
          blocks_checkin: false, blocks_kit_delivery: true,
        });
      }

      if (importType === 'current_event_registrations' && !eventId) {
        status = 'error';
        errorMessage = 'Selecione explicitamente o evento para importar os inscritos.';
      }

      if (importType === 'current_event_registrations' && status !== 'error' && eventRules) {
        const addIssue = (issue: ImportDataIssue) => dataIssues.push(issue);
        if (!row.cpf_input) {
          addIssue({ field_code: 'cpf', issue_type: 'missing_required_identity', message: 'CPF obrigatorio ausente.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        } else if (!isValidCpf(row.cpf_input)) {
          addIssue({ field_code: 'cpf', issue_type: 'invalid_identity', message: 'CPF invalido.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        }

        if (row.email_input && !row.email) {
          addIssue({ field_code: 'email', issue_type: 'invalid_format', message: 'E-mail informado e invalido.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false });
        }
        if (row.phone_input && (!row.phone || row.phone.length < 10 || row.phone.length > 11)) {
          addIssue({ field_code: 'phone', issue_type: 'invalid_format', message: 'Telefone informado e invalido.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false });
        }

        if (!row.birth_date_input) {
          addIssue({ field_code: 'birth_date', issue_type: 'missing_required_age', message: 'Data de nascimento obrigatoria ausente.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        } else if (!row.birth_date) {
          addIssue({ field_code: 'birth_date', issue_type: 'invalid_date', message: 'Data de nascimento invalida.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        } else if (eventRules.minAge > 0 && !eventRules.eventStartsAt) {
          // So exigimos a data do evento quando ha de fato uma idade minima
          // configurada -- sem isso, evento sem restricao de idade nao
          // deveria travar a importacao por falta de starts_at.
          addIssue({ field_code: 'event_date', issue_type: 'missing_required_for_age', message: 'Evento sem data de inicio para validar maioridade.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        } else if (eventRules.eventStartsAt) {
          // calculateAgeAtEventDate e a mesma fonte canonica usada no
          // checkout publico (src/app/inscricao/actions.ts) -- nunca um "18"
          // hardcoded aqui; o limiar real vem de eventRules.minAge
          // (events.min_age), igual ao checkout.
          const ageAtEvent = calculateAgeAtEventDate(row.birth_date, eventRules.eventStartsAt);
          if (ageAtEvent === null) {
            addIssue({ field_code: 'birth_date', issue_type: 'invalid_date', message: 'Nascimento invalido ou posterior a data do evento.', blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
          } else if (eventRules.minAge > 0 && ageAtEvent < eventRules.minAge) {
            addIssue({ field_code: 'birth_date', issue_type: 'underage_at_event', message: `Pessoa menor de ${eventRules.minAge} anos na data do evento.`, blocks_payment: false, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
          }
        }

        const batchResolution = resolveImportOptionWithDefault(row.batch, eventRules.batches.map((batch) => ({ id: batch.id, name: batch.name })), defaultBatchId);
        const categoryResolution = resolveImportOptionWithDefault(row.category, eventRules.categories, defaultCategoryId);
        row.resolved_batch_id = batchResolution.option?.id ?? null;
        row.resolved_category_id = categoryResolution.option?.id ?? null;
        if (!row.resolved_batch_id) addIssue({ field_code: 'batch', issue_type: 'unresolved', message: 'Lote nao resolvido de forma deterministica.', blocks_payment: true, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        if (!row.resolved_category_id) addIssue({ field_code: 'category', issue_type: 'unresolved', message: 'Categoria nao resolvida de forma deterministica.', blocks_payment: true, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });

        const price = eventRules.prices.find((candidate) => candidate.batchId === row.resolved_batch_id && candidate.categoryId === row.resolved_category_id);
        if (row.resolved_batch_id && row.resolved_category_id && !price) {
          addIssue({ field_code: 'price', issue_type: 'unresolved', message: 'Preco nao encontrado para lote e categoria.', blocks_payment: true, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        } else if (price) {
          row.resolved_male_price = price.malePrice;
          row.resolved_female_price = price.femalePrice;
          if (price.malePrice !== price.femalePrice && !row.gender) addIssue({ field_code: 'gender', issue_type: 'missing_required_for_pricing', message: 'Informe o genero para calcular o valor.', blocks_payment: true, blocks_ticket_issuance: true, blocks_checkin: false, blocks_kit_delivery: false });
        }

        if (eventRules.shirtRequiredForImport && (!row.shirt_type || !row.shirt_size)) {
          addIssue({ field_code: 'shirt_selection', issue_type: 'missing_required_for_inventory', message: 'Modelo e tamanho da camiseta pendentes para o kit.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: true });
        } else if (row.shirt_type && row.shirt_size && eventRules.shirtVariantKeys.size
          && !eventRules.shirtVariantKeys.has(`${row.shirt_type.trim()} ${row.shirt_size.trim()}`)) {
          // Camiseta preenchida mas o par tipo+tamanho nao corresponde a
          // nenhuma variante ativa do evento -- sem isso a linha "passa" na
          // importacao e so falha (silenciosamente) na entrega fisica do kit.
          addIssue({ field_code: 'shirt_selection', issue_type: 'invalid_variant', message: `Camiseta "${row.shirt_type} ${row.shirt_size}" nao corresponde a nenhuma variante ativa do evento.`, blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: true });
        }
        if (dataIssues.length) {
          status = 'data_pending';
          errorMessage = dataIssues.map((issue) => issue.message).join(' ');
        }
      }

      if (importType === 'historical_participations' && historicalEventKey && status !== 'error') {
        if (row.cpf && seenHistoricalCpfs.has(row.cpf)) {
          // CPF e a identidade canonica -- duas linhas com o MESMO cpf sao a
          // mesma pessoa mesmo que o nome varie (apelido, erro de digitacao
          // etc.), e a chave composta abaixo (que inclui o nome) nao pega
          // esse caso porque exige as tres partes identicas.
          status = 'duplicate';
          resolution = 'pending';
          errorMessage = 'Participacao historica duplicada para este evento (mesmo CPF ja importado neste arquivo).';
        } else {
          if (row.cpf) seenHistoricalCpfs.add(row.cpf);

          const identityParts = [
            row.cpf ? `cpf:${row.cpf}` : null,
            row.email ? `email:${row.email}` : null,
            row.normalized_name ? `name:${row.normalized_name}` : null,
          ].filter(Boolean) as string[];

          if (identityParts.length > 0) {
            const compoundKey = `${historicalEventKey}::${identityParts.join('|')}`;
            if (seenHistoricalIdentityKeys.has(compoundKey) || identityParts.some((part) => historicalIdentitySet.has(part))) {
              status = 'duplicate';
              resolution = 'pending';
              errorMessage = 'Participacao historica duplicada para este evento.';
            } else {
              seenHistoricalIdentityKeys.add(compoundKey);
            }
          }
        }
      }

      if (importType === 'current_event_registrations' && status !== 'error' && row.cpf) {
        // CPF repetido dentro do MESMO arquivo (pessoa nova, ainda sem
        // cadastro no banco) nao aparece em cpfMap (que so reflete o que ja
        // existia antes do upload) -- sem isso, cada ocorrencia seguia como
        // "pronta" e virava um pedido/ingresso separado e silencioso.
        if (seenCurrentEventCpfs.has(row.cpf)) {
          status = 'duplicate';
          resolution = 'pending';
          errorMessage = 'CPF ja aparece em outra linha deste arquivo.';
        } else {
          seenCurrentEventCpfs.add(row.cpf);
        }
      }

      if (status !== 'error' && row.cpf && cpfMap.has(row.cpf)) {
        const matched = cpfMap.get(row.cpf)!;
        if (importType === 'current_event_registrations') {
          matchedRegistrationContactId = String(matched.id ?? '');
        } else {
          matchedParticipantId = String(matched.id ?? '');
        }
        matchedUserId = importType === 'historical_participations' && matched.user_id ? String(matched.user_id) : null;
        if (importType === 'current_event_registrations') {
          if (contactIdsAlreadyInEvent.has(String(matched.id ?? ''))) {
            // Pessoa ja tem pedido/ingresso vivo NESTE evento (import anterior
            // ja finalizado, ou qualquer outro fluxo) -- exige decisao
            // explicita em vez de gerar mais um pedido silencioso.
            status = 'duplicate';
            resolution = 'pending';
            errorMessage = 'Esta pessoa ja possui inscricao para este evento.';

            const existing = existingOrderItemByContact.get(String(matched.id ?? ''));
            const importedType = row.shirt_type?.trim();
            const importedSize = row.shirt_size?.trim();
            const existingType = existing?.shirtType?.trim();
            const existingSize = existing?.shirtSize?.trim();
            if (existing && importedType && importedSize && existingType && existingSize
              && (importedType.toLowerCase() !== existingType.toLowerCase() || importedSize.toLowerCase() !== existingSize.toLowerCase())) {
              // Nao decide sozinho: so registra o conflito (comparavel,
              // resolvivel pelo mesmo dialogo admin que ja resolve qualquer
              // pendencia de camiseta) -- nunca sobrescreve nem cria ingresso.
              errorMessage = `Conflito de camiseta: ja consta "${existingType} ${existingSize}"; a importacao trouxe "${importedType} ${importedSize}".`;
              shirtConflictsToFlag.push({
                rowIndex: index, orderItemId: existing.id,
                existingType, existingSize, importedType, importedSize,
              });
            }
          } else {
            resolution = 'link_existing';
          }
        } else {
          status = 'duplicate';
          resolution = 'pending';
        }
      } else if (importType === 'historical_participations' && status !== 'error' && row.email && emailMap.has(row.email)) {
        const matched = emailMap.get(row.email)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = matched.user_id ? String(matched.user_id) : null;
        status = 'duplicate';
        resolution = 'pending';
      } else if (status !== 'error' && row.normalized_name && normalizedNameMap.has(row.normalized_name)) {
        const matched = normalizedNameMap.get(row.normalized_name)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = importType === 'historical_participations' && matched.user_id ? String(matched.user_id) : null;
        status = 'review_required';
        resolution = 'pending';
        errorMessage = 'Possivel correspondencia encontrada.';
      }

      if (importType === 'current_event_registrations' && status === 'ready' && !matchedRegistrationContactId) {
        resolution = 'create_new';
      }

      if (status === 'error') errorRows += 1;
      if (status === 'duplicate') duplicateRows += 1;
      if (status === 'review_required') reviewRows += 1;

      return {
        import_batch_id: batchId,
        row_number: index + 1,
        raw_data: rows[index],
        normalized_data: row,
        status,
        resolution,
        error_message: errorMessage,
        data_issues: dataIssues,
        matched_participant_id: matchedParticipantId,
        registration_contact_id: matchedRegistrationContactId,
        matched_user_id: matchedUserId,
      };
    });

    const insertRowsResult = await supabase.from('import_batch_rows').insert(rowsToInsert);
    if (insertRowsResult.error) {
      throw new Error(insertRowsResult.error.message);
    }

    if (shirtConflictsToFlag.length) {
      const rowNumbers = shirtConflictsToFlag.map((conflict) => conflict.rowIndex + 1);
      const { data: insertedConflictRows } = await supabase
        .from('import_batch_rows')
        .select('id,row_number')
        .eq('import_batch_id', batchId)
        .in('row_number', rowNumbers);
      const rowIdByNumber = new Map((insertedConflictRows ?? []).map((row) => [Number(row.row_number), String(row.id)]));
      for (const conflict of shirtConflictsToFlag) {
        const rowId = rowIdByNumber.get(conflict.rowIndex + 1);
        if (!rowId) continue;
        const { error: flagError } = await supabase.rpc('flag_import_shirt_conflict', {
          p_import_batch_id: batchId,
          p_import_batch_row_id: rowId,
          p_order_item_id: conflict.orderItemId,
          p_existing_shirt_type: conflict.existingType,
          p_existing_shirt_size: conflict.existingSize,
          p_imported_shirt_type: conflict.importedType,
          p_imported_shirt_size: conflict.importedSize,
        });
        if (flagError) {
          console.error('[IMPORT SHIRT CONFLICT FLAG ERROR]', { batchId, rowId, error: flagError });
        }
      }
    }

    const pendingRows = rowsToInsert.filter((row) => row.status === 'data_pending').length;
    const skippedRows = errorRows + duplicateRows;
    await supabase
      .from('import_batches')
      .update({
        error_rows: errorRows,
        skipped_rows: skippedRows,
        imported_rows: 0,
        status: 'ready_for_review',
      })
      .eq('id', batchId);

    const preview = rowsToInsert.slice(0, 30).map((row) => ({
      row_number: row.row_number,
      status: row.status,
      resolution: row.resolution,
      full_name: String((row.normalized_data as Record<string, unknown>).full_name ?? ''),
      cpf_masked: maskCpf(String((row.normalized_data as Record<string, unknown>).cpf ?? '')),
      email: String((row.normalized_data as Record<string, unknown>).email ?? ''),
      message: row.error_message,
      data_issues: row.data_issues,
    }));

    return {
      success: true as const,
      batchId,
      headers,
      mapping,
      summary: {
        totalRows: rowsToInsert.length,
        readyRows: rowsToInsert.length - errorRows - duplicateRows - reviewRows - pendingRows,
        duplicateRows,
        reviewRows,
        pendingRows,
        errorRows,
      },
      preview,
    };
  } catch (error) {
    return {
      success: false as const,
      message: error instanceof Error ? error.message : 'Falha ao processar arquivo.',
    };
  }
}

export async function setImportRowResolutionAction(input: {
  batchId: string;
  rowId: string;
  resolution: 'pending' | 'link_existing' | 'create_new' | 'ignore' | 'mark_duplicate';
}) {
  const parsed = z.object({
    batchId: z.string().uuid(),
    rowId: z.string().uuid(),
    resolution: rowResolutionSchema,
  }).safeParse(input);

  if (!parsed.success) {
    return { success: false as const, message: 'Dados de resolucao invalidos.' };
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase
    .from('import_batch_rows')
    .update({ resolution: parsed.data.resolution })
    .eq('id', parsed.data.rowId)
    .eq('import_batch_id', parsed.data.batchId);

  if (error) {
    return { success: false as const, message: error.message };
  }

  return { success: true as const };
}

export async function getImportBatchDetailsAction(batchId: string) {
  const supabase = await createServerSupabaseClient();

  const [{ data: batch, error: batchError }, { data: rows, error: rowsError }] = await Promise.all([
    supabase
      .from('import_batches')
      .select('id, file_name, import_type, event_id, total_rows, imported_rows, skipped_rows, error_rows, status, created_at, completed_at')
      .eq('id', batchId)
      .single(),
    supabase
      .from('import_batch_rows')
      .select('id, row_number, status, resolution, error_message, data_issues, normalized_data, matched_participant_id, matched_user_id')
      .eq('import_batch_id', batchId)
      .order('row_number', { ascending: true }),
  ]);

  if (batchError) return { success: false as const, message: batchError.message };
  if (rowsError) return { success: false as const, message: rowsError.message };

  return {
    success: true as const,
    batch,
    rows: (rows ?? []).map((row) => {
      const normalized = row.normalized_data as Record<string, unknown>;
      return {
        id: String(row.id),
        row_number: Number(row.row_number),
        status: String(row.status),
        resolution: String(row.resolution),
        error_message: row.error_message ? String(row.error_message) : null,
        data_issues: Array.isArray(row.data_issues) ? row.data_issues : [],
        matched_participant_id: row.matched_participant_id ? String(row.matched_participant_id) : null,
        matched_user_id: row.matched_user_id ? String(row.matched_user_id) : null,
        full_name: String(normalized.full_name ?? ''),
        cpf_masked: maskCpf(String(normalized.cpf ?? '')),
        email: String(normalized.email ?? ''),
        row: normalized,
      };
    }),
  };
}

async function ensureParticipationHistoryForCurrentParticipant(params: {
  participantId: string;
  userId: string | null;
  eventId: string;
  eventYear: number;
  fullName: string;
  cpf: string | null;
  email: string | null;
  importBatchId: string;
}) {
  const supabase = await createServerSupabaseClient();

  const existing = await supabase
    .from('participation_history')
    .select('id')
    .eq('participant_id', params.participantId)
    .eq('import_batch_id', params.importBatchId)
    .limit(1)
    .maybeSingle();

  if (existing.error) throw existing.error;

  if (existing.data?.id) return;

  const inserted = await supabase
    .from('participation_history')
    .insert({
      event_id: params.eventId,
      user_id: params.userId,
      participant_id: params.participantId,
      legacy_event_name: null,
      event_year: params.eventYear,
      full_name: params.fullName,
      normalized_name: normalizeForMatch(params.fullName),
      cpf: params.cpf,
      email: params.email,
      status: 'confirmed',
      source: 'import',
      import_batch_id: params.importBatchId,
      manually_verified: false,
    });
  if (inserted.error) throw inserted.error;
}

export async function executeImportBatchAction(
  batchId: string,
  paymentMode: 'pending' | 'confirm_all' = 'pending',
  paymentReason?: string,
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false as const, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .select('id, import_type, event_id, organization_id, historical_event_label, historical_event_key, historical_event_year, total_rows, imported_by')
    .eq('id', batchId)
    .single();

  if (batchError || !batch?.id) {
    return { success: false as const, message: batchError?.message ?? 'Lote nao encontrado.' };
  }

  if (String(batch.imported_by ?? '') !== user.id) {
    return { success: false as const, message: 'Somente o operador do lote pode iniciar esta importacao.' };
  }

  const persistedPaymentMode = paymentMode === 'confirm_all' ? 'confirm_all' : 'pending';
  const { error: intentError } = await supabase
    .from('import_batches')
    .update({
      payment_mode_original: persistedPaymentMode,
      payment_reason_original: paymentReason?.trim() || null,
    })
    .eq('id', batchId)
    .eq('imported_by', user.id);
  if (intentError) {
    return { success: false as const, message: `Nao foi possivel preservar a intencao financeira: ${intentError.message}` };
  }

  const { data: rows, error: rowsError } = await supabase
    .from('import_batch_rows')
    .select('id, row_number, status, resolution, data_issues, normalized_data, matched_participant_id, matched_user_id, registration_contact_id, order_item_id, ticket_id')
    .eq('import_batch_id', batchId)
    .order('row_number', { ascending: true });

  if (rowsError) {
    return { success: false as const, message: rowsError.message };
  }

  let importedRows = 0;
  let skippedRows = 0;
  let errorRows = 0;
  let updatedRows = 0;
  let duplicateRows = 0;
  let reviewRows = 0;
  const createdAccounts = 0;
  const activationSent = 0;
  let generatedTickets = 0;
  let generatedQrs = 0;
  let pendingDataRows = 0;

  for (const row of rows ?? []) {
    const normalized = row.normalized_data as Record<string, unknown>;
    const status = String(row.status);
    const resolution = String(row.resolution);

    if (!isRowReadyToImport(status, resolution)) {
      if (status === 'duplicate') duplicateRows += 1;
      if (status === 'review_required') reviewRows += 1;
      skippedRows += 1;
      continue;
    }

    try {
      const fullName = String(normalized.full_name ?? '').trim();
      const cpf = normalizeCpf(String(normalized.cpf ?? ''));
      const email = normalizeEmail(String(normalized.email ?? ''));
      const phone = normalizePhone(String(normalized.phone ?? ''));
      const birthDate = String(normalized.birth_date ?? '').trim() || null;
      const gender = normalizeImportedGender(String(normalized.gender ?? ''));
      const city = String(normalized.city ?? '').trim() || null;
      const eventYear = Number(normalized.event_year ?? 0) || new Date().getFullYear();
      const registrationStatus = normalizeStatus(String(normalized.status ?? 'pending'));
      const paymentMethod = normalizePaymentMethod(String(normalized.payment_method ?? 'pix')) ?? 'pix';

      if (!fullName) {
        await supabase
          .from('import_batch_rows')
          .update({ status: 'error', error_message: 'Nome obrigatorio ausente.' })
          .eq('id', row.id);
        errorRows += 1;
        continue;
      }

      if (batch.import_type === 'historical_participations') {
        const matchedParticipantId = row.matched_participant_id ? String(row.matched_participant_id) : null;
        const matchedUserId = row.matched_user_id ? String(row.matched_user_id) : null;

        let linkedUserId: string | null = matchedUserId;
        if (!batch.organization_id) throw new Error('Organizacao da importacao historica nao definida.');
        const { data: resolvedContact, error: contactError } = await supabase.rpc('resolve_import_registration_contact', {
          p_organization_id: String(batch.organization_id),
          p_expected_registration_contact_id: row.registration_contact_id ? String(row.registration_contact_id) : null,
          p_full_name: fullName, p_cpf: cpf, p_birth_date: birthDate, p_gender: gender,
          p_phone: phone, p_email: email, p_city: city,
        });
        if (contactError) throw contactError;
        const historicalContactId = (resolvedContact as Record<string, unknown> | null)?.registration_contact_id
          ? String((resolvedContact as Record<string, unknown>).registration_contact_id) : null;
        if (!historicalContactId) throw new Error('Falha ao resolver o cadastro da participacao historica.');
        if (!linkedUserId && cpf) {
          const { data: profileByCpf } = await supabase
            .from('customer_profiles')
            .select('user_id')
            .eq('cpf', cpf)
            .maybeSingle();
          linkedUserId = profileByCpf?.user_id ? String(profileByCpf.user_id) : null;
        }

        const insertResult = await supabase
          .from('participation_history')
          .insert({
            event_id: batch.event_id,
            user_id: linkedUserId,
            participant_id: matchedParticipantId,
            registration_contact_id: historicalContactId,
            legacy_event_name: String(batch.historical_event_label ?? '').trim() || null,
            historical_event_key: String(batch.historical_event_key ?? ''),
            event_year: Number(batch.historical_event_year ?? normalized.event_year ?? new Date().getFullYear()),
            full_name: fullName,
            normalized_name: normalizeForMatch(fullName),
            cpf,
            email,
            status: registrationStatus === 'confirmed' ? 'confirmed' : registrationStatus,
            source: 'import',
            import_batch_id: batchId,
            manually_verified: resolution === 'link_existing',
          })
          .select('id')
          .single();

        if (insertResult.error) {
          throw insertResult.error;
        }

        if (linkedUserId) {
          await supabase.rpc('recalculate_customer_loyalty', { p_user_id: linkedUserId });
        }

        await supabase
          .from('import_batch_rows')
          .update({ status: 'imported', error_message: null, registration_contact_id: historicalContactId })
          .eq('id', row.id);

        importedRows += 1;
        continue;
      }

      if (batch.import_type === 'current_event_registrations') {
        const eventId = batch.event_id ? String(batch.event_id) : null;
        if (!eventId) {
          throw new Error('Evento obrigatorio para importacao de inscritos atuais.');
        }

        const issues = Array.isArray(row.data_issues) ? row.data_issues as ImportDataIssue[] : [];
        const { data: upserted, error: upsertError } = await supabase.rpc('import_current_event_contact_first', {
          p_import_batch_id: batchId,
          p_import_batch_row_id: String(row.id),
          p_expected_registration_contact_id: resolution === 'link_existing' && row.registration_contact_id ? String(row.registration_contact_id) : null,
          p_full_name: fullName,
          p_cpf: String(normalized.cpf_input ?? cpf ?? '').trim() || null,
          p_birth_date: birthDate,
          p_gender: gender,
          p_phone: phone,
          p_email: email,
          p_city: city,
          p_shirt_type: String(normalized.shirt_type ?? '').trim() || null,
          p_shirt_size: String(normalized.shirt_size ?? '').trim() || null,
          p_registration_batch_id: String(normalized.resolved_batch_id ?? '').trim() || null,
          p_ticket_category_id: String(normalized.resolved_category_id ?? '').trim() || null,
          p_payment_method: paymentMethod,
          p_import_issues: issues,
          p_assign_holder: true,
        });
        if (upsertError) throw upsertError;
        const upsertResult = upserted as Record<string, unknown> | null;
        const participantId = upsertResult?.participant_id ? String(upsertResult.participant_id) : null;
        const registrationContactId = upsertResult?.registration_contact_id ? String(upsertResult.registration_contact_id) : null;
        const orderItemId = upsertResult?.order_item_id ? String(upsertResult.order_item_id) : null;
        const createdParticipant = upsertResult?.created_participant_projection === true;
        const participantUserId = upsertResult?.user_id ? String(upsertResult.user_id) : null;
        const hasBlockingDataIssues = upsertResult?.has_issuance_blockers === true;
        if (createdParticipant) {
          if (issues.length) pendingDataRows += 1;
        } else {
          updatedRows += 1;
        }

        if (!participantId || !registrationContactId || !orderItemId) {
          throw new Error('Falha ao criar o ingresso importado.');
        }

        const genderInference = normalized.gender_inference;
        if (genderInference && typeof genderInference === 'object' && !Array.isArray(genderInference)) {
          const inference = genderInference as Record<string, unknown>;
          const { data: auditRecorded, error: inferenceAuditError } = await supabase.rpc('record_import_field_inference_audit', {
            p_import_batch_id: batchId,
            p_participant_id: participantId,
            p_inferred_field: String(inference.inferred_field ?? ''),
            p_inferred_value: String(inference.inferred_value ?? ''),
            p_inference_source: String(inference.inference_source ?? ''),
            p_original_value: String(inference.original_value ?? ''),
          });
          if (inferenceAuditError || auditRecorded !== true) {
            console.error('[IMPORT AUDIT ERROR]', {
              batchId,
              participantId,
              code: inferenceAuditError?.code ?? null,
              message: inferenceAuditError?.message ?? 'RPC de auditoria retornou false.',
            });
          }
        }

        // No MVP do importador administrativo, não criamos nem convidamos contas.
        // O participante importado continua utilizável no painel, entrega de kits e check-in.
        await ensureParticipationHistoryForCurrentParticipant({
          participantId,
          userId: participantUserId,
          eventId,
          eventYear,
          fullName,
          cpf,
          email,
          importBatchId: batchId,
        });

        if (!hasBlockingDataIssues && persistedPaymentMode === 'confirm_all') {
          const { data: finalization, error: finalizationError } = await supabase.rpc(
            'finalize_imported_ticket_after_issue_resolution',
            { p_order_item_id: orderItemId, p_resolved_fields: [] },
          );
          if (finalizationError) throw finalizationError;
          if ((finalization as Record<string, unknown> | null)?.ticket_id) {
            generatedTickets += 1;
            generatedQrs += 1;
          }
        }

        await supabase
          .from('import_batch_rows')
          .update({ status: 'imported', error_message: null, matched_participant_id: participantId, registration_contact_id: registrationContactId, order_item_id: orderItemId })
          .eq('id', row.id);

        importedRows += 1;
        continue;
      }

      await supabase
        .from('import_batch_rows')
        .update({ status: 'skipped', error_message: 'Tipo de importacao ainda nao implementado.' })
        .eq('id', row.id);
      skippedRows += 1;
    } catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'object' && error !== null
        ? [
            'message' in error ? String(error.message ?? '') : '',
            'details' in error ? String(error.details ?? '') : '',
            'hint' in error ? String(error.hint ?? '') : '',
            'code' in error ? `Codigo: ${String(error.code ?? '')}` : '',
          ]
            .filter(Boolean)
            .join(' | ')
        : String(error);

  console.error('[IMPORT ERROR]', {
    batchId,
    rowId: row.id,
    rowNumber: row.row_number,
    normalized,
    error,
    message,
  });

  await supabase
    .from('import_batch_rows')
    .update({
      status: 'error',
      error_message: message || 'Falha inesperada durante importacao.',
    })
    .eq('id', row.id);

  errorRows += 1;
  }
}

  await supabase
    .from('import_batches')
    .update({
      imported_rows: importedRows,
      skipped_rows: skippedRows + duplicateRows,
      error_rows: errorRows,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', batchId);

  // A finalizacao ocorre por participante depois que a origem foi registrada.
  let batchPaymentReport: Record<string, number> | null = null;
  if (persistedPaymentMode === 'confirm_all' && batch.import_type === 'current_event_registrations') {
    batchPaymentReport = {
      paymentsConfirmed: generatedTickets,
      paymentsSkipped: pendingDataRows,
      paymentsFailed: errorRows,
    };
  }

  revalidatePath('/importacoes');
  revalidatePath('/inscricoes');

  const { data: openBatchIssues } = batch.import_type === 'current_event_registrations'
    ? await supabase.from('participant_data_issues').select('participant_id').eq('import_batch_id', batchId).eq('status', 'open')
    : { data: [] };
  const pendingParticipants = new Set((openBatchIssues ?? []).map((issue) => String(issue.participant_id))).size;

  return {
    success: true as const,
    report: {
      processed: (rows ?? []).length,
      imported: importedRows,
      completedWithoutPending: Math.max(0, importedRows - pendingParticipants),
      updated: updatedRows,
      duplicated: duplicateRows,
      reviewRequired: reviewRows,
      errors: errorRows,
      accountsCreated: createdAccounts,
      activationsSent: activationSent,
      ticketsGenerated: generatedTickets,
      qrCodesGenerated: generatedQrs,
      awaitingData: pendingParticipants,
      ...(batchPaymentReport ?? {}),
    },
  };
}

export async function exportImportErrorsCsvAction(batchId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('import_batch_rows')
    .select('row_number, status, error_message, normalized_data')
    .eq('import_batch_id', batchId)
    .in('status', ['error', 'data_pending', 'duplicate', 'review_required'])
    .order('row_number', { ascending: true });

  if (error) {
    return { success: false as const, message: error.message };
  }

  const lines = ['linha,status,mensagem,nome,cpf,email'];
  for (const row of data ?? []) {
    const normalized = row.normalized_data as Record<string, unknown>;
    const name = String(normalized.full_name ?? '').replace(/,/g, ' ');
    const cpf = maskCpf(String(normalized.cpf ?? ''));
    const email = String(normalized.email ?? '').replace(/,/g, ' ');
    const message = String(row.error_message ?? '').replace(/,/g, ' ');
    lines.push(`${row.row_number},${row.status},${message},${name},${cpf},${email}`);
  }

  return {
    success: true as const,
    fileName: `import-errors-${batchId}.csv`,
    content: lines.join('\n'),
  };
}
