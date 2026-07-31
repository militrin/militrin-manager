'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { upsertCustomerProfileCompat } from '@/lib/account/upsert-customer-profile';
import { updateCustomerProfileCompat } from '@/lib/account/update-customer-profile';
import { createServiceRoleSupabaseClient } from '@/lib/supabase/admin';
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
  email: string | null;
  phone: string | null;
  birth_date: string | null;
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

function parseAmount(value: string | null | undefined) {
  const normalized = String(value ?? '')
    .trim()
    .replace(/\./g, '')
    .replace(',', '.');

  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
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
  const get = (field: CanonicalField) => String(rawRow[mapping[field] ?? ''] ?? '').trim();

  const fullName = removeDuplicateSpaces(get('full_name'));
  const rawYear = get('event_year');
  const parsedYear = rawYear ? Number(rawYear) : null;

  const row: NormalizedRow = {
    full_name: fullName,
    normalized_name: normalizeForMatch(fullName),
    cpf: normalizeCpf(get('cpf')),
    email: normalizeEmail(get('email')),
    phone: normalizePhone(get('phone')),
    birth_date: parseBrDateToISO(get('birth_date')),
    gender: removeDuplicateSpaces(get('gender')) || null,
    city: removeDuplicateSpaces(get('city')) || null,
    event_name: removeDuplicateSpaces(get('event_name')) || null,
    event_year: Number.isFinite(parsedYear ?? NaN) ? parsedYear : fallbackYear,
    category: removeDuplicateSpaces(get('category')) || null,
    batch: removeDuplicateSpaces(get('batch')) || null,
    shirt_type: removeDuplicateSpaces(get('shirt_type')) || null,
    shirt_size: removeDuplicateSpaces(get('shirt_size')) || null,
    status: normalizeStatus(get('status')),
    amount: parseAmount(get('amount')),
    payment_method: normalizePaymentMethod(get('payment_method')),
  };

  return row;
}

async function maybeCreateOrInviteImportedAccount(params: {
  email: string | null;
  fullName: string;
  cpf: string | null;
  birthDate: string | null;
  gender: string | null;
  phone: string | null;
  city: string | null;
}) {
  if (!params.email) {
    return { userId: null as string | null, activationSent: false, pendingActivation: false };
  }

  const supabase = await createServerSupabaseClient();

  const { data: existingProfileByEmail } = await supabase
    .from('customer_profiles')
    .select('user_id')
    .ilike('email', params.email)
    .maybeSingle();

  if (existingProfileByEmail?.user_id) {
    return { userId: String(existingProfileByEmail.user_id), activationSent: false, pendingActivation: false };
  }

  const allowDevCpfPassword = process.env.NODE_ENV !== 'production' && process.env.MILITRIN_IMPORT_DEV_CPF_PASSWORD === 'true';

  let invitedUserId: string | null = null;
  let activationSent = false;
  if (allowDevCpfPassword && params.cpf) {
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.auth.admin.createUser({
      email: params.email,
      password: params.cpf,
      email_confirm: true,
      user_metadata: {
        full_name: params.fullName,
        imported_account: true,
      },
    });

    if (error && !/already|registered|exists/i.test(error.message)) {
      throw error;
    }

    invitedUserId = data.user?.id ? String(data.user.id) : null;
  } else {
    const admin = createServiceRoleSupabaseClient();
    const { data, error } = await admin.auth.admin.inviteUserByEmail(params.email, {
      data: {
        full_name: params.fullName,
        imported_account: true,
      },
    });

    if (error && !/already|registered|exists/i.test(error.message)) {
      throw error;
    }

    invitedUserId = data.user?.id ? String(data.user.id) : null;
    activationSent = Boolean(invitedUserId);
  }

  if (!invitedUserId) {
    return { userId: null as string | null, activationSent, pendingActivation: true };
  }

  await upsertCustomerProfileCompat(supabase, {
    userId: invitedUserId,
    fullName: params.fullName,
    cpf: params.cpf,
    birthDate: params.birthDate,
    gender: params.gender,
    phone: params.phone,
    email: params.email,
    city: params.city,
    loyaltyTierId: null,
    loyaltyOverride: false,
    loyaltyOverrideReason: null,
    showInParticipantList: true,
    allowFriendRequests: true,
    profileVisibility: 'participants',
  });

  await updateCustomerProfileCompat(supabase, invitedUserId, {
    account_status: allowDevCpfPassword ? 'active' : 'pending_activation',
    must_complete_profile: true,
    must_change_password: allowDevCpfPassword,
    imported_at: new Date().toISOString(),
  });

  return {
    userId: invitedUserId,
    activationSent,
    pendingActivation: !allowDevCpfPassword,
  };
}

function isRowReadyToImport(status: string, resolution: string) {
  if (status === 'error') return false;
  if (status === 'duplicate') return resolution === 'create_new';
  if (status === 'review_required') return resolution === 'link_existing' || resolution === 'create_new';
  return true;
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

  try {
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

    const [{ data: participantsByCpf }, { data: participantsByEmail }, { data: participantsByEvent }, { data: existingHistoricalRows }] = await Promise.all([
      cpfs.size
        ? supabase
            .from('participants')
            .select('id, full_name, cpf, email, event_id, user_id')
            .in('cpf', Array.from(cpfs))
        : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
      emails.size
        ? supabase
            .from('participants')
            .select('id, full_name, cpf, email, event_id, user_id')
            .in('email', Array.from(emails))
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

    const rowsToInsert = normalizedRows.map((row, index) => {
      let status = 'ready';
      let resolution = 'pending';
      let errorMessage: string | null = null;
      let matchedParticipantId: string | null = null;
      let matchedUserId: string | null = null;

      if (!row.full_name) {
        status = 'error';
        errorMessage = 'Nome obrigatorio ausente.';
      }

      if (importType === 'current_event_registrations' && !eventId) {
        status = 'error';
        errorMessage = 'Selecione um evento para importar inscritos do evento atual.';
      }

      if (importType === 'historical_participations' && historicalEventKey && status !== 'error') {
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

      if (status !== 'error' && row.cpf && cpfMap.has(row.cpf)) {
        const matched = cpfMap.get(row.cpf)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = matched.user_id ? String(matched.user_id) : null;
        status = 'duplicate';
        resolution = 'pending';
      } else if (status !== 'error' && row.email && emailMap.has(row.email)) {
        const matched = emailMap.get(row.email)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = matched.user_id ? String(matched.user_id) : null;
        status = 'duplicate';
        resolution = 'pending';
      } else if (status !== 'error' && row.normalized_name && normalizedNameMap.has(row.normalized_name)) {
        const matched = normalizedNameMap.get(row.normalized_name)!;
        matchedParticipantId = String(matched.id ?? '');
        matchedUserId = matched.user_id ? String(matched.user_id) : null;
        status = 'review_required';
        resolution = 'pending';
        errorMessage = 'Possivel correspondencia encontrada.';
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
        matched_participant_id: matchedParticipantId,
        matched_user_id: matchedUserId,
      };
    });

    const insertRowsResult = await supabase.from('import_batch_rows').insert(rowsToInsert);
    if (insertRowsResult.error) {
      throw new Error(insertRowsResult.error.message);
    }

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
    }));

    return {
      success: true as const,
      batchId,
      headers,
      mapping,
      summary: {
        totalRows: rowsToInsert.length,
        readyRows: rowsToInsert.length - errorRows - duplicateRows - reviewRows,
        duplicateRows,
        reviewRows,
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
      .select('id, row_number, status, resolution, error_message, normalized_data, matched_participant_id, matched_user_id')
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
    .maybeSingle();

  if (existing.data?.id) return;

  await supabase
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
}

export async function executeImportBatchAction(batchId: string) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    return { success: false as const, message: 'Sessao expirada. Entre novamente.' };
  }

  const { data: batch, error: batchError } = await supabase
    .from('import_batches')
    .select('id, import_type, event_id, historical_event_label, historical_event_key, historical_event_year, total_rows')
    .eq('id', batchId)
    .single();

  if (batchError || !batch?.id) {
    return { success: false as const, message: batchError?.message ?? 'Lote nao encontrado.' };
  }

  const { data: rows, error: rowsError } = await supabase
    .from('import_batch_rows')
    .select('id, row_number, status, resolution, normalized_data, matched_participant_id, matched_user_id')
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
  let createdAccounts = 0;
  let activationSent = 0;
  let generatedTickets = 0;
  let generatedQrs = 0;

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
      const gender = String(normalized.gender ?? '').trim() || null;
      const city = String(normalized.city ?? '').trim() || null;
      const eventYear = Number(normalized.event_year ?? 0) || new Date().getFullYear();
      const registrationStatus = normalizeStatus(String(normalized.status ?? 'pending'));
      const paymentMethod = normalizePaymentMethod(String(normalized.payment_method ?? 'pix')) ?? 'pix';
      const shirtType = String(normalized.shirt_type ?? '').trim() || 'Sem camiseta';
      const shirtSize = String(normalized.shirt_size ?? '').trim() || 'N/A';

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
          .update({ status: 'imported', error_message: null })
          .eq('id', row.id);

        importedRows += 1;
        continue;
      }

      if (batch.import_type === 'current_event_registrations') {
        const eventId = batch.event_id ? String(batch.event_id) : null;
        if (!eventId) {
          throw new Error('Evento obrigatorio para importacao de inscritos atuais.');
        }

        let participantId: string | null = row.matched_participant_id ? String(row.matched_participant_id) : null;

        if (!participantId && cpf) {
          const { data: existingParticipant } = await supabase
            .from('participants')
            .select('id, event_id')
            .eq('event_id', eventId)
            .eq('cpf', cpf)
            .maybeSingle();

          if (existingParticipant?.id) {
            participantId = String(existingParticipant.id);
          }
        }

        if (!participantId) {
          const { data: created, error: createError } = await supabase.rpc('create_registration', {
            p_full_name: fullName,
            p_cpf: cpf ?? `IMPORT${Date.now()}${row.row_number}`,
            p_birth_date: birthDate,
            p_gender: gender ?? 'Masculino',
            p_phone: phone ?? '00000000000',
            p_email: email ?? `${normalizeForMatch(fullName).replace(/\s+/g, '.')}@importacao.local`,
            p_city: city ?? 'Nao informado',
            p_shirt_type: shirtType,
            p_shirt_size: shirtSize,
            p_registration_status: registrationStatus === 'confirmed' ? 'confirmed' : 'pending',
            p_notes: 'Importacao administrativa',
            p_payment_method: paymentMethod,
            p_payment_status: registrationStatus === 'confirmed' ? 'paid' : 'pending',
            p_event_id: eventId,
            p_coupon_code: null,
            p_ticket_category_id: null,
          });

          if (createError) {
            throw createError;
          }

          const first = Array.isArray(created) ? created[0] : created;
          participantId = first?.participant_id ? String(first.participant_id) : null;
        } else {
          updatedRows += 1;
        }

        if (!participantId) {
          throw new Error('Falha ao obter participante importado.');
        }

        if (registrationStatus === 'confirmed') {
          const { data: ticketData } = await supabase
            .from('tickets')
            .select('id')
            .eq('participant_id', participantId)
            .maybeSingle();

          if (!ticketData?.id) {
            const confirmResult = await supabase.rpc('confirm_registration_payment', { p_participant_id: participantId });
            if (confirmResult.error) {
              throw confirmResult.error;
            }
            generatedTickets += 1;
            generatedQrs += 1;
          }
        }

        let accountUserId: string | null = row.matched_user_id ? String(row.matched_user_id) : null;
        if (!accountUserId && email) {
          const inviteResult = await maybeCreateOrInviteImportedAccount({
            email,
            fullName,
            cpf,
            birthDate,
            gender,
            phone,
            city,
          });

          if (inviteResult.userId) {
            accountUserId = inviteResult.userId;
            createdAccounts += 1;
          }
          if (inviteResult.activationSent) {
            activationSent += 1;
          }
        }

        if (accountUserId) {
          await supabase
            .from('participants')
            .update({ user_id: accountUserId })
            .eq('id', participantId);

          if (cpf) {
            await supabase.rpc('link_participation_history_by_cpf', {
              p_user_id: accountUserId,
              p_cpf: cpf,
              p_actor: `import:${user.id}`,
            });
          }

          await ensureParticipationHistoryForCurrentParticipant({
            participantId,
            userId: accountUserId,
            eventId,
            eventYear,
            fullName,
            cpf,
            email,
            importBatchId: batchId,
          });

          await supabase.rpc('recalculate_customer_loyalty', { p_user_id: accountUserId });
        } else {
          await ensureParticipationHistoryForCurrentParticipant({
            participantId,
            userId: null,
            eventId,
            eventYear,
            fullName,
            cpf,
            email,
            importBatchId: batchId,
          });
        }

        await supabase
          .from('import_batch_rows')
          .update({ status: 'imported', error_message: null })
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
      const message = error instanceof Error ? error.message : 'Falha inesperada durante importacao.';
      await supabase
        .from('import_batch_rows')
        .update({ status: 'error', error_message: message })
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

  revalidatePath('/importacoes');
  revalidatePath('/inscricoes');

  return {
    success: true as const,
    report: {
      processed: (rows ?? []).length,
      imported: importedRows,
      updated: updatedRows,
      duplicated: duplicateRows,
      reviewRequired: reviewRows,
      errors: errorRows,
      accountsCreated: createdAccounts,
      activationsSent: activationSent,
      ticketsGenerated: generatedTickets,
      qrCodesGenerated: generatedQrs,
    },
  };
}

export async function exportImportErrorsCsvAction(batchId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase
    .from('import_batch_rows')
    .select('row_number, status, error_message, normalized_data')
    .eq('import_batch_id', batchId)
    .in('status', ['error', 'duplicate', 'review_required'])
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
