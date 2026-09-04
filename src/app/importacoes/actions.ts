'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { hasPermission } from '@/lib/admin/permissions';
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
  resolveImportOptionWithDefault,
  type ImportDataIssue,
} from '@/lib/imports/import-row-validation';
import { calculateAgeAtEventDate } from '@/lib/utils/date';
import { normalizeImportedShirtType } from '@/lib/imports/shirt-type';
import { classifyImportedCpf, type CpfCellKind } from '@/lib/imports/cpf-excel';
import {
  assignOccurrenceIndexes,
  buildPurchaseFingerprint,
  hashSourceFileBytes,
} from '@/lib/imports/purchase-identity';
import {
  classifyCurrentEventPurchase,
  classifyIntraFileSharedEmails,
} from '@/lib/imports/classify-current-event-purchase';
import {
  isCommerciallyCompletedImportStatus,
  isImportRowReadyToImport,
  resolveImportBatchOperationalState,
} from '@/lib/imports/batch-operational-state';

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
  cpf_raw: string | null;
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
  external_purchase_key: string | null;
  cpf_cell_kind: CpfCellKind;
  row_fingerprint: string | null;
  occurrence_index: number;
  excel_cpf_candidate: string | null;
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
  const cpfRaw = get('cpf') || null;
  const birthDateInput = get('birth_date') || null;
  const emailInput = get('email') || null;
  const phoneInput = get('phone') || null;
  const externalPurchaseKey = removeDuplicateSpaces(get('external_purchase_key')) || null;
  const shirtType = normalizeImportedShirtType(originalShirtType);
  const importedGender = normalizeImportedGender(get('gender'));

  const row: NormalizedRow = {
    full_name: fullName,
    normalized_name: normalizeForMatch(fullName),
    cpf: normalizeCpf(cpfRaw),
    cpf_input: cpfRaw,
    cpf_raw: cpfRaw,
    email: normalizeEmail(emailInput),
    email_input: emailInput,
    phone: normalizePhone(phoneInput),
    phone_input: phoneInput,
    birth_date: parseImportedBirthDate(birthDateInput),
    birth_date_input: birthDateInput,
    gender: importedGender,
    city: removeDuplicateSpaces(get('city')) || null,
    event_name: removeDuplicateSpaces(get('event_name')) || null,
    event_year: Number.isFinite(parsedYear ?? NaN) ? parsedYear : fallbackYear,
    category: removeDuplicateSpaces(get('category')) || null,
    batch: removeDuplicateSpaces(get('batch')) || null,
    shirt_type: shirtType,
    shirt_size: removeDuplicateSpaces(get('shirt_size')) || null,
    status: normalizeStatus(get('status')),
    amount: parseAmount(get('amount')),
    payment_method: normalizePaymentMethod(get('payment_method')),
    resolved_batch_id: null,
    resolved_category_id: null,
    resolved_male_price: null,
    resolved_female_price: null,
    external_purchase_key: externalPurchaseKey,
    cpf_cell_kind: 'unknown',
    row_fingerprint: null,
    occurrence_index: 1,
    excel_cpf_candidate: null,
  };

  return row;
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
    const fileBytes = await file.arrayBuffer();
    const sourceFileHash = hashSourceFileBytes(fileBytes);
    if (importType === 'current_event_registrations' && eventId) {
      const { data: previousSameFile } = await supabase
        .from('import_batches')
        .select('id,file_name,status,imported_rows,total_rows,created_at,completed_at,imported_by')
        .eq('organization_id', currentOrganization.id)
        .eq('event_id', eventId)
        .eq('source_file_hash', sourceFileHash)
        .in('status', ['completed', 'ready_for_review', 'processing'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (previousSameFile?.id) {
        return {
          success: true as const,
          alreadyImported: true as const,
          batchId: String(previousSameFile.id),
          previousBatch: {
            id: String(previousSameFile.id),
            fileName: previousSameFile.file_name ? String(previousSameFile.file_name) : file.name,
            status: String(previousSameFile.status ?? ''),
            importedRows: Number(previousSameFile.imported_rows ?? 0),
            totalRows: Number(previousSameFile.total_rows ?? 0),
            createdAt: previousSameFile.created_at ? String(previousSameFile.created_at) : null,
            completedAt: previousSameFile.completed_at ? String(previousSameFile.completed_at) : null,
            importedBy: previousSameFile.imported_by ? String(previousSameFile.imported_by) : null,
          },
          headers: [],
          mapping: {},
          summary: {
            totalRows: Number(previousSameFile.total_rows ?? 0),
            readyRows: 0,
            duplicateRows: 0,
            reviewRows: 0,
            pendingRows: 0,
            errorRows: 0,
          },
          preview: [],
        };
      }
    }

    const parsedSheet = await parseSpreadsheetFile(file);
    const { headers, rows, cellKinds } = parsedSheet;
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

    const normalizedRows = rows.map((rawRow, index) => {
      const normalized = toCanonicalRow(rawRow, mapping, historicalEventYear);
      const cpfHeader = mapping.cpf;
      if (cpfHeader && cellKinds[index]) {
        normalized.cpf_cell_kind = cellKinds[index][cpfHeader] ?? 'unknown';
      }
      const classified = classifyImportedCpf(normalized.cpf_input, normalized.cpf_cell_kind);
      normalized.excel_cpf_candidate = classified.excelCandidate;
      normalized.row_fingerprint = buildPurchaseFingerprint({
        fullName: normalized.full_name,
        cpfInput: normalized.cpf_input,
        emailInput: normalized.email_input,
        phoneInput: normalized.phone_input,
        category: normalized.category,
        batch: normalized.batch,
        shirtType: normalized.shirt_type,
        shirtSize: normalized.shirt_size,
        amount: normalized.amount,
        paymentMethod: normalized.payment_method,
        externalPurchaseKey: normalized.external_purchase_key,
      });
      if (normalized.cpf) cpfs.add(normalized.cpf);
      if (normalized.email) emails.add(normalized.email);
      if (normalized.normalized_name) normalizedNames.add(normalized.normalized_name);
      return normalized;
    });
    const occurrenceIndexes = assignOccurrenceIndexes(normalizedRows.map((row) => row.row_fingerprint ?? ''));
    normalizedRows.forEach((row, index) => {
      row.occurrence_index = occurrenceIndexes[index] ?? 1;
    });

    const eventRules = importType === 'current_event_registrations'
      ? await getCurrentEventImportRules(supabase, eventId)
      : null;

    const [{ data: contactsByCpf }, { data: contactsByEmail }, { data: participantsByCpf }, { data: participantsByEmail }, { data: participantsByEvent }, { data: existingHistoricalRows }] = await Promise.all([
      importType === 'current_event_registrations' && cpfs.size && eventRules?.organizationId
        ? supabase.from('registration_contacts').select('id,user_id,full_name,cpf,email').eq('organization_id', eventRules.organizationId).in('cpf', Array.from(cpfs))
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      importType === 'current_event_registrations' && emails.size && eventRules?.organizationId
        ? supabase.from('registration_contacts').select('id,user_id,full_name,cpf,email').eq('organization_id', eventRules.organizationId).in('email', Array.from(emails))
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
            .select('id, full_name, cpf, email, event_id, user_id, registration_contact_id')
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

    const emailMap = new Map<string, Record<string, unknown>[]>();
    const pushUnique = (map: Map<string, Record<string, unknown>[]>, key: string, record: Record<string, unknown>) => {
      const list = map.get(key) ?? [];
      if (!list.some((item) => String(item.id ?? item.registration_contact_id ?? '') === String(record.id ?? record.registration_contact_id ?? ''))) {
        list.push(record);
      }
      map.set(key, list);
    };
    for (const contact of contactsByEmail ?? []) {
      const key = normalizeEmail(String(contact.email ?? ''));
      if (key) pushUnique(emailMap, key, contact);
    }
    for (const participant of participantsByEmail ?? []) {
      const key = normalizeEmail(String(participant.email ?? ''));
      if (key) pushUnique(emailMap, key, participant);
    }

    // AUDITORIA (caso real TIEVENT): participantsByEvent (tabela legada
    // "participants", projecao espelhada em event_id) NAO e' atualizada
    // quando o cadastro e' editado depois via Cadastros -> Editar (so
    // registration_contacts muda) -- por isso um candidato de nome
    // aparecia na fila de revisao com o full_name/email ANTIGOS mesmo
    // depois do cadastro real ter sido renomeado. O vinculo
    // (registration_contact_id) sempre foi o correto -- so o texto exibido
    // ao administrador ficava obsoleto. Resolvido buscando os dados atuais
    // direto de registration_contacts para exibir/gravar no candidato,
    // nunca a projecao legada.
    const nameMatchContactIds = Array.from(new Set(
      (participantsByEvent ?? []).map((participant) => String(participant.registration_contact_id ?? '')).filter(Boolean),
    ));
    const { data: liveContactsForNameMatch } = nameMatchContactIds.length
      ? await supabase.from('registration_contacts').select('id,full_name,cpf,email,user_id').in('id', nameMatchContactIds)
      : { data: [] as Array<Record<string, unknown>> };
    const liveContactByIdMap = new Map<string, Record<string, unknown>>();
    for (const contact of liveContactsForNameMatch ?? []) {
      liveContactByIdMap.set(String(contact.id), contact);
    }

    const normalizedNameMap = new Map<string, Record<string, unknown>>();
    for (const participant of participantsByEvent ?? []) {
      const key = normalizeForMatch(String(participant.full_name ?? ''));
      if (!key) continue;
      const liveContact = participant.registration_contact_id ? liveContactByIdMap.get(String(participant.registration_contact_id)) : null;
      normalizedNameMap.set(key, liveContact ? { ...participant, full_name: liveContact.full_name, cpf: liveContact.cpf, email: liveContact.email } : participant);
    }

    const historicalIdentitySet = new Set<string>();
    for (const historicalRow of existingHistoricalRows ?? []) {
      const rowCpf = normalizeCpf(String(historicalRow.cpf ?? ''));
      const rowEmail = normalizeEmail(String(historicalRow.email ?? ''));
      const rowName = normalizeForMatch(String(historicalRow.normalized_name ?? ''));
      if (rowCpf) historicalIdentitySet.add(`cpf:${rowCpf}`);
      if (rowEmail) historicalIdentitySet.add(`email:${rowEmail}`);
      if (rowName) historicalIdentitySet.add(`name:${rowName}`);
    }

    const fingerprintSet = Array.from(new Set(normalizedRows.map((row) => row.row_fingerprint).filter(Boolean))) as string[];
    const externalKeys = Array.from(new Set(normalizedRows.map((row) => row.external_purchase_key).filter(Boolean))) as string[];
    const { data: previousPurchases } = importType === 'current_event_registrations' && eventId && fingerprintSet.length
      ? await supabase
        .from('import_batch_rows')
        .select('id,row_fingerprint,occurrence_index,source_file_hash,external_purchase_key,status,import_batches!inner(event_id,organization_id,status)')
        .in('row_fingerprint', fingerprintSet)
        .eq('status', 'imported')
        .eq('import_batches.event_id', eventId)
        .eq('import_batches.organization_id', currentOrganization.id)
      : { data: [] as Array<Record<string, unknown>> };
    const previousByFingerprint = new Map<string, Array<{
      importBatchRowId: string;
      sourceFileHash: string;
      occurrenceIndex: number;
      externalPurchaseKey: string | null;
    }>>();
    for (const previous of previousPurchases ?? []) {
      const fingerprint = String((previous as { row_fingerprint?: string }).row_fingerprint ?? '');
      if (!fingerprint) continue;
      const list = previousByFingerprint.get(fingerprint) ?? [];
      list.push({
        importBatchRowId: String((previous as { id: string }).id),
        sourceFileHash: String((previous as { source_file_hash?: string }).source_file_hash ?? ''),
        occurrenceIndex: Number((previous as { occurrence_index?: number }).occurrence_index ?? 1),
        externalPurchaseKey: (previous as { external_purchase_key?: string | null }).external_purchase_key
          ? String((previous as { external_purchase_key?: string }).external_purchase_key)
          : null,
      });
      previousByFingerprint.set(fingerprint, list);
    }
    if (externalKeys.length && importType === 'current_event_registrations' && eventId) {
      const { data: previousByExternal } = await supabase
        .from('import_batch_rows')
        .select('id,row_fingerprint,occurrence_index,source_file_hash,external_purchase_key,status,import_batches!inner(event_id,organization_id)')
        .in('external_purchase_key', externalKeys)
        .eq('status', 'imported')
        .eq('import_batches.event_id', eventId)
        .eq('import_batches.organization_id', currentOrganization.id);
      for (const previous of previousByExternal ?? []) {
        const fingerprint = String((previous as { row_fingerprint?: string }).row_fingerprint ?? `ext:${String((previous as { external_purchase_key?: string }).external_purchase_key ?? '')}`);
        const list = previousByFingerprint.get(fingerprint) ?? [];
        list.push({
          importBatchRowId: String((previous as { id: string }).id),
          sourceFileHash: String((previous as { source_file_hash?: string }).source_file_hash ?? ''),
          occurrenceIndex: Number((previous as { occurrence_index?: number }).occurrence_index ?? 1),
          externalPurchaseKey: (previous as { external_purchase_key?: string | null }).external_purchase_key
            ? String((previous as { external_purchase_key?: string }).external_purchase_key)
            : null,
        });
        previousByFingerprint.set(fingerprint, list);
      }
    }

    const intraFileSharedEmails = classifyIntraFileSharedEmails(
      normalizedRows.map((row, index) => ({ email: row.email, cpf: row.cpf, index })),
    );

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
        source_file_hash: sourceFileHash,
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

    const seenIntraFileCpfs = new Set<string>();
    const rowsToInsert = normalizedRows.map((row, index) => {
      let status = 'ready';
      let resolution = 'pending';
      let errorMessage: string | null = null;
      let matchedParticipantId: string | null = null;
      let matchedRegistrationContactId: string | null = null;
      let matchedUserId: string | null = null;
      let identityMatchDetails: Record<string, unknown> = {};
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
          addIssue({ field_code: 'cpf', issue_type: 'missing_required_identity', message: 'CPF obrigatorio ausente. Compra preservada com identidade pendente.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false, resolution_scope: 'user_resolvable' });
        } else if (classifyImportedCpf(row.cpf_input, row.cpf_cell_kind).kind === 'excel_leading_zero') {
          addIssue({ field_code: 'cpf', issue_type: 'excel_leading_zero', message: 'Possivel zero inicial removido pelo Excel.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false, resolution_scope: 'user_resolvable' });
        } else if (!isValidCpf(row.cpf_input)) {
          addIssue({ field_code: 'cpf', issue_type: 'invalid_identity', message: 'CPF invalido. Compra preservada com identidade pendente.', blocks_payment: false, blocks_ticket_issuance: false, blocks_checkin: false, blocks_kit_delivery: false, resolution_scope: 'user_resolvable' });
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

      if (importType === 'current_event_registrations' && status !== 'error') {
        const cpfMatch = row.cpf ? cpfMap.get(row.cpf) : undefined;
        const emailMatches = row.email ? (emailMap.get(row.email) ?? []) : [];
        const emailMatch = emailMatches.find((candidate) => String(candidate.id ?? candidate.registration_contact_id ?? '') !== String(cpfMatch?.id ?? '')) ?? emailMatches[0];
        const nameMatch = row.normalized_name ? normalizedNameMap.get(row.normalized_name) : undefined;
        const toCandidate = (matched: Record<string, unknown>, reason: string) => ({
          registration_contact_id: String(matched.registration_contact_id ?? matched.id ?? ''),
          participant_id: matched.registration_contact_id ? String(matched.id ?? '') : null,
          user_id: matched.user_id ? String(matched.user_id) : null,
          full_name: String(matched.full_name ?? ''), cpf: String(matched.cpf ?? ''),
          email: String(matched.email ?? ''), reason,
        });
        const intraFileAdditionalPurchase = Boolean(row.cpf && seenIntraFileCpfs.has(row.cpf) && !cpfMatch);
        const purchase = classifyCurrentEventPurchase({
          cpfInput: row.cpf_input,
          cpfCellKind: row.cpf_cell_kind,
          email: row.email,
          cpfMatch: cpfMatch ? toCandidate(cpfMatch, 'cpf_exact') : null,
          emailMatch: emailMatch ? toCandidate(emailMatch, 'email_exact') : null,
          nameMatch: nameMatch ? toCandidate(nameMatch, 'name_exact_suggestion') : null,
          sourceFileHash,
          occurrenceIndex: row.occurrence_index,
          existingSameEventPurchases: [
            ...(previousByFingerprint.get(row.row_fingerprint ?? '') ?? []),
            ...(row.external_purchase_key ? (previousByFingerprint.get(`ext:${row.external_purchase_key}`) ?? []) : []),
          ],
          externalPurchaseKey: row.external_purchase_key,
        });
        if (row.cpf) seenIntraFileCpfs.add(row.cpf);
        if (purchase.status === 'review_required') {
          status = 'review_required';
          resolution = 'pending';
          errorMessage = purchase.errorMessage;
          identityMatchDetails = purchase.identityMatchDetails;
          matchedRegistrationContactId = String(
            (purchase.identityMatchDetails as { candidates?: Array<{ registration_contact_id?: string }> }).candidates?.[0]?.registration_contact_id
            ?? '',
          ) || matchedRegistrationContactId;
        } else {
          if (purchase.resolution === 'link_existing') {
            resolution = 'link_existing';
            matchedRegistrationContactId = String(
              (purchase.identityMatchDetails as { candidates?: Array<{ registration_contact_id?: string }> }).candidates?.[0]?.registration_contact_id
              ?? '',
            ) || null;
            matchedUserId = cpfMatch?.user_id ? String(cpfMatch.user_id) : null;
          } else if (status === 'ready') {
            resolution = purchase.resolution;
          }
          identityMatchDetails = purchase.identityMatchDetails;
          if (purchase.additionalPurchase || intraFileAdditionalPurchase) {
            identityMatchDetails = {
              ...identityMatchDetails,
              additional_purchase: true,
              reason: String((identityMatchDetails as { reason?: string }).reason ?? 'additional_purchase'),
            };
          }
          if (intraFileSharedEmails.has(index)) {
            identityMatchDetails = {
              ...identityMatchDetails,
              account_review: 'shared_email',
              reason: String((identityMatchDetails as { reason?: string }).reason ?? 'shared_email_account_review'),
            };
            errorMessage = errorMessage
              ?? 'E-mail compartilhado. Pessoas permanecem separadas; revise a conta proprietaria dos ingressos.';
          }
          if (purchase.status === 'data_pending' && status !== 'error') {
            status = 'data_pending';
            errorMessage = purchase.errorMessage ?? errorMessage;
          }
        }
        for (const issue of purchase.identityIssues) {
          if (!dataIssues.some((existing) => existing.field_code === issue.field_code && existing.issue_type === issue.issue_type)) {
            dataIssues.push(issue);
          }
        }
        if (purchase.possibleReimportOfRowId) {
          identityMatchDetails = { ...identityMatchDetails, previous_import_batch_row_id: purchase.possibleReimportOfRowId };
        }
        if (emailMatches.length) {
          identityMatchDetails = {
            ...identityMatchDetails,
            owner_candidates: emailMatches.map((candidate) => toCandidate(candidate, 'shared_email')),
          };
        }
      } else if (status !== 'error' && row.cpf && cpfMap.has(row.cpf)) {
        const matched = cpfMap.get(row.cpf)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = importType === 'historical_participations' && matched.user_id ? String(matched.user_id) : null;
        if (importType !== 'current_event_registrations') {
          status = 'duplicate';
          resolution = 'pending';
        }
      } else if (importType === 'historical_participations' && status !== 'error' && row.email && emailMap.has(row.email)) {
        const matched = emailMap.get(row.email)![0];
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = matched.user_id ? String(matched.user_id) : null;
        status = 'duplicate';
        resolution = 'pending';
      } else if (importType === 'historical_participations' && status !== 'error' && row.normalized_name && normalizedNameMap.has(row.normalized_name)) {
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
        identity_match_details: identityMatchDetails,
        row_fingerprint: row.row_fingerprint,
        occurrence_index: row.occurrence_index,
        source_file_hash: sourceFileHash,
        external_purchase_key: row.external_purchase_key,
        cpf_excel_candidate: row.excel_cpf_candidate,
        cpf_cell_kind: row.cpf_cell_kind,
        possible_reimport_of_row_id: (identityMatchDetails as { previous_import_batch_row_id?: string }).previous_import_batch_row_id ?? null,
      };
    });

    const insertRowsResult = await supabase.from('import_batch_rows').insert(rowsToInsert);
    if (insertRowsResult.error) {
      throw new Error(insertRowsResult.error.message);
    }

    const pendingRows = rowsToInsert.filter((row) => row.status === 'data_pending').length;
    const skippedRows = errorRows + duplicateRows;
    // Staging persistido: ready_for_review aqui significa "arquivo validado e
    // gravado", nao "importacao comercial concluida". A UI deriva o estado
    // operacional pelas rows (revisao real vs pronto para executar).
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

// As Server Actions de leitura/escrita de um lote de importacao especifico
// (abaixo) dependiam so da RLS do banco para autorizacao -- e ate a
// migration 20260838000000 a RLS dessas tabelas nem existia, deixando-as
// como endpoint aberto (POST da Server Action e invocavel diretamente,
// sem passar pelo layout que hoje faz requirePermission('imports.view')).
// Essa checagem replica explicitamente, no nivel da action, a mesma regra
// de acesso: usuario autenticado + permissao imports.view (a mesma exigida
// pelo layout e por import_current_event_contact_first) + organizacao do
// evento do lote (nunca confiando em nenhum organization_id vindo do
// cliente -- resolvida aqui a partir do event_id do proprio lote). A RLS
// continua valendo como segunda camada, nao como substituta desta checagem.
async function resolveImportBatchAccess(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  batchId: string,
): Promise<{ ok: true; userId: string } | { ok: false; message: string }> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.id) {
    return { ok: false, message: 'Sessao expirada. Entre novamente.' };
  }

  const allowed = await hasPermission('imports.view', user.id);
  if (!allowed) {
    return { ok: false, message: 'Sem permissao para gerenciar importacoes.' };
  }

  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .select('event_id')
    .eq('id', batchId)
    .maybeSingle();
  if (batchError || !batch) {
    return { ok: false, message: 'Lote de importacao invalido.' };
  }

  if (batch.event_id) {
    const { data: event, error: eventError } = await supabase
      .from('events')
      .select('organization_id')
      .eq('id', batch.event_id)
      .maybeSingle();
    if (eventError || !event) {
      return { ok: false, message: 'Evento do lote invalido.' };
    }

    const { data: canAccess } = await supabase.rpc('user_can_access_organization', {
      p_user_id: user.id,
      p_organization_id: event.organization_id,
    });
    if (!canAccess) {
      return { ok: false, message: 'Sem acesso a organizacao deste lote.' };
    }
  }

  return { ok: true, userId: user.id };
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
  const access = await resolveImportBatchAccess(supabase, parsed.data.batchId);
  if (!access.ok) {
    return { success: false as const, message: access.message };
  }

  if (parsed.data.resolution === 'pending' || parsed.data.resolution === 'mark_duplicate') {
    return { success: false as const, message: 'Escolha vincular, criar novo cadastro ou ignorar a linha.' };
  }
  const decision = parsed.data.resolution === 'ignore' ? 'ignore' : parsed.data.resolution;
  const { data: row } = await supabase.from('import_batch_rows')
    .select('registration_contact_id,identity_match_details').eq('id', parsed.data.rowId).eq('import_batch_id', parsed.data.batchId).maybeSingle();
  const candidates = ((row?.identity_match_details as { candidates?: Array<{ registration_contact_id?: string }> } | null)?.candidates ?? []);
  const candidateId = row?.registration_contact_id ? String(row.registration_contact_id) : candidates[0]?.registration_contact_id ?? null;
  const { error } = await supabase.rpc('resolve_import_batch_row_review', {
    p_row_id: parsed.data.rowId,
    p_decision: decision,
    p_registration_contact_id: decision === 'link_existing' ? candidateId : null,
  });

  if (error) {
    return { success: false as const, message: error.message };
  }

  return { success: true as const };
}

export async function getImportBatchDetailsAction(batchId: string) {
  const supabase = await createServerSupabaseClient();
  const access = await resolveImportBatchAccess(supabase, batchId);
  if (!access.ok) {
    return { success: false as const, message: access.message };
  }

  const [{ data: batch, error: batchError }, { data: rows, error: rowsError }] = await Promise.all([
    supabase
      .from('import_batches')
      .select('id, file_name, import_type, event_id, total_rows, imported_rows, skipped_rows, error_rows, status, created_at, completed_at')
      .eq('id', batchId)
      .single(),
    supabase
      .from('import_batch_rows')
      .select('id, row_number, status, resolution, error_message, data_issues, normalized_data, matched_participant_id, matched_user_id, registration_contact_id, identity_match_details, review_decision, reviewed_at')
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
        registration_contact_id: row.registration_contact_id ? String(row.registration_contact_id) : null,
        identity_match_details: row.identity_match_details ?? {},
        full_name: String(normalized.full_name ?? ''),
        cpf_masked: maskCpf(String(normalized.cpf ?? '')),
        email: String(normalized.email ?? ''),
        row: normalized,
      };
    }),
    summary: {
      totalRows: rows?.length ?? 0,
      readyRows: (rows ?? []).filter((row) => row.status === 'ready').length,
      pendingRows: (rows ?? []).filter((row) => row.status === 'data_pending').length,
      duplicateRows: (rows ?? []).filter((row) => row.status === 'duplicate').length,
      reviewRows: (rows ?? []).filter((row) => row.status === 'review_required' && row.resolution === 'pending').length,
      errorRows: (rows ?? []).filter((row) => row.status === 'error').length,
    },
    operationalState: resolveImportBatchOperationalState({
      status: batch.status,
      importedRows: batch.imported_rows,
      completedAt: batch.completed_at,
      rows: (rows ?? []).map((row) => ({
        status: String(row.status),
        resolution: String(row.resolution),
      })),
    }),
  };
}

export async function resolveImportReviewAction(formData: FormData) {
  const parsed = z.object({
    rowId: z.string().uuid(),
    decision: z.enum([
      'link_existing',
      'create_new',
      'ignore',
      'confirm_new_purchase',
      'ignore_technical_duplicate',
      'confirm_excel_cpf',
      'keep_pending_cpf',
      'provide_alternate_cpf',
      'assign_owner_contact',
      'keep_people_separate',
    ]),
    registrationContactId: z.string().uuid().nullable(),
    cpf: z.string().optional(),
    ownerRegistrationContactId: z.string().uuid().nullable(),
  }).safeParse({
    rowId: String(formData.get('row_id') ?? ''),
    decision: String(formData.get('decision') ?? ''),
    registrationContactId: String(formData.get('registration_contact_id') ?? '').trim() || null,
    cpf: String(formData.get('cpf') ?? '').trim() || undefined,
    ownerRegistrationContactId: String(formData.get('owner_registration_contact_id') ?? '').trim() || null,
  });
  if (!parsed.success) return { success: false as const, message: 'Decisao de revisao invalida.' };
  const supabase = await createServerSupabaseClient();
  const { data: row } = await supabase.from('import_batch_rows').select('import_batch_id').eq('id', parsed.data.rowId).maybeSingle();
  if (!row?.import_batch_id) return { success: false as const, message: 'Linha de importacao nao encontrada.' };
  const access = await resolveImportBatchAccess(supabase, String(row.import_batch_id));
  if (!access.ok) return { success: false as const, message: access.message };
  const { error } = await supabase.rpc('resolve_import_batch_row_review', {
    p_row_id: parsed.data.rowId,
    p_decision: parsed.data.decision,
    p_registration_contact_id: parsed.data.ownerRegistrationContactId ?? parsed.data.registrationContactId,
    p_payload: {
      cpf: parsed.data.cpf ?? null,
      owner_registration_contact_id: parsed.data.ownerRegistrationContactId,
    },
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath('/importacoes/revisoes');
  revalidatePath('/importacoes');
  return { success: true as const };
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

  const access = await resolveImportBatchAccess(supabase, batchId);
  if (!access.ok) {
    return { success: false as const, message: access.message };
  }

  if (paymentMode === 'confirm_all') {
    const canConfirmPayment = await hasPermission('finance.confirm_payment');
    if (!canConfirmPayment) {
      return { success: false as const, message: 'Sem permissao para confirmar pagamentos e emitir ingressos.' };
    }
  }

  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .select('id, import_type, event_id, organization_id, historical_event_label, historical_event_key, historical_event_year, total_rows, imported_by, status, imported_rows, completed_at')
    .eq('id', batchId)
    .single();

  if (batchError || !batch?.id) {
    return { success: false as const, message: batchError?.message ?? 'Lote nao encontrado.' };
  }

  if (String(batch.imported_by ?? '') !== user.id) {
    return { success: false as const, message: 'Somente o operador do lote pode iniciar esta importacao.' };
  }

  if (isCommerciallyCompletedImportStatus(String(batch.status ?? ''))) {
    return { success: false as const, message: 'Este lote ja foi importado.' };
  }

  const { data: rows, error: rowsError } = await supabase
    .from('import_batch_rows')
    .select('id, row_number, status, resolution, data_issues, normalized_data, matched_participant_id, matched_user_id, registration_contact_id, order_item_id, ticket_id, intended_owner_contact_id')
    .eq('import_batch_id', batchId)
    .order('row_number', { ascending: true });

  if (rowsError) {
    return { success: false as const, message: rowsError.message };
  }

  const importableCount = (rows ?? []).filter((row) => isImportRowReadyToImport(String(row.status), String(row.resolution))).length;
  if (importableCount === 0) {
    return { success: false as const, message: 'Nao ha linhas prontas para importar neste lote.' };
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

    if (!isImportRowReadyToImport(status, resolution)) {
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
        if (row.order_item_id) {
          importedRows += 1;
          continue;
        }
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
          p_intended_owner_contact_id: row.intended_owner_contact_id ? String(row.intended_owner_contact_id) : null,
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

  const { data: finalRows } = await supabase.from('import_batch_rows').select('status,resolution')
    .eq('import_batch_id', batchId);
  const totalImportedRows = (finalRows ?? []).filter((row) => row.status === 'imported').length;
  const totalErrorRows = (finalRows ?? []).filter((row) => row.status === 'error').length;
  const totalSkippedRows = (finalRows ?? []).filter((row) => ['duplicate', 'skipped'].includes(String(row.status))).length;
  const remainingReviewCount = (finalRows ?? []).filter((row) => row.status === 'review_required' && row.resolution === 'pending').length;

  await supabase
    .from('import_batches')
    .update({
      imported_rows: totalImportedRows,
      skipped_rows: totalSkippedRows,
      error_rows: totalErrorRows,
      status: remainingReviewCount > 0 ? 'ready_for_review' : 'completed',
      completed_at: remainingReviewCount > 0 ? null : new Date().toISOString(),
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
      processed: finalRows?.length ?? (rows ?? []).length,
      imported: totalImportedRows,
      completedWithoutPending: Math.max(0, totalImportedRows - pendingParticipants),
      updated: updatedRows,
      duplicated: duplicateRows,
      reviewRequired: remainingReviewCount,
      errors: totalErrorRows,
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
  const access = await resolveImportBatchAccess(supabase, batchId);
  if (!access.ok) {
    return { success: false as const, message: access.message };
  }

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
