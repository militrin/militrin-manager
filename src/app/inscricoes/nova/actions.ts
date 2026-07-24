'use server';

import { createServerSupabaseClient } from '@/lib/supabase/server';
import { createRegistrationWithRpc } from '@/lib/supabase/rpc';
import type { RegistrationFormValues } from '@/lib/validation/registration';
import { removeCpfMask } from '@/lib/validation/registration';

export async function createRegistrationAction(values: RegistrationFormValues) {
  const supabase = await createServerSupabaseClient();
  const cpf = removeCpfMask(values.cpf);
  const amount = Number(values.amount.replace(/[^\d.]/g, '')) || 0;
  const paymentStatus = values.payment_status === 'Confirmado' ? 'paid' : 'pending';

  const { data: existingParticipant, error: existingError } = await supabase
    .from('participants')
    .select('id')
    .eq('cpf', cpf)
    .eq('event_id', (await supabase.from('events').select('id').eq('is_active', true).maybeSingle()).data?.id)
    .maybeSingle();

  if (existingError) {
    return { success: false, message: existingError.message };
  }

  if (existingParticipant) {
    return { success: false, message: 'Este CPF já está cadastrado para o evento ativo.' };
  }

  try {
    const registrationId = await createRegistrationWithRpc({
      full_name: values.full_name.trim(),
      cpf,
      birth_date: values.birth_date,
      gender: values.gender || null,
      phone: values.phone.replace(/\D/g, ''),
      email: values.email?.trim() || null,
      city: values.city?.trim() || null,
      shirt_type: values.shirt_type,
      shirt_size: values.shirt_size,
      payment_method: values.payment_method,
      amount,
      payment_status: paymentStatus,
      notes: values.notes?.trim() || null,
    });

    return {
      success: true,
      message: `Inscrição criada com sucesso. Número: ${registrationId}`,
      registration: { id: registrationId },
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Não foi possível criar a inscrição.',
    };
  }
}
