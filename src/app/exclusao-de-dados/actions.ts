'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import {
  normalizeDataDeletionRequest,
  validateDataDeletionRequest,
  type DataDeletionRequestInput,
} from '@/lib/public/data-deletion-request';

export async function submitDataDeletionRequestAction(input: DataDeletionRequestInput): Promise<{
  success: boolean;
  message: string;
}> {
  const validationError = validateDataDeletionRequest(input);
  if (validationError) {
    return { success: false, message: validationError };
  }

  const normalized = normalizeDataDeletionRequest(input);

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('submit_data_deletion_request', {
    p_full_name: normalized.fullName,
    p_email: normalized.email,
    p_instagram_handle: normalized.instagramHandle,
    p_notes: normalized.notes,
    p_confirmed: true,
    p_website: normalized.website,
  });

  if (error) {
    const raw = error.message?.trim() || '';
    const isInfrastructureError = /schema cache|Could not find the function|submit_data_deletion_request/i.test(raw);
    return {
      success: false,
      message: isInfrastructureError
        ? 'Não foi possível registrar a solicitação agora. Tente novamente em instantes.'
        : raw || 'Não foi possível registrar a solicitação agora.',
    };
  }

  return {
    success: true,
    message: 'Solicitação registrada. Ela será analisada; este envio não apaga dados automaticamente.',
  };
}
