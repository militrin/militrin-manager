'use server';

import { z } from 'zod';
import { createServerSupabaseClient } from '@/lib/supabase/server';

const submitSchema = z.object({
  type: z.enum(['problem', 'suggestion', 'question']),
  message: z.string().trim().min(1, 'Descreva o que aconteceu.').max(4000, 'Mensagem muito longa.'),
  screenshotPath: z.string().trim().min(1).nullable(),
  pagePath: z.string().trim().min(1).nullable(),
  eventSlugHint: z.string().trim().min(1).nullable(),
  technicalContext: z.record(z.string(), z.unknown()),
});

export async function submitFeedbackAction(input: {
  type: 'problem' | 'suggestion' | 'question';
  message: string;
  screenshotPath: string | null;
  pagePath: string | null;
  eventSlugHint: string | null;
  technicalContext: Record<string, unknown>;
}) {
  const parsed = submitSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, message: parsed.error.issues[0]?.message ?? 'Dados inválidos.' };

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc('submit_user_feedback', {
    p_type: parsed.data.type,
    p_message: parsed.data.message,
    p_screenshot_path: parsed.data.screenshotPath,
    p_page_path: parsed.data.pagePath,
    p_event_slug_hint: parsed.data.eventSlugHint,
    p_technical_context: parsed.data.technicalContext,
  });

  if (error) return { success: false as const, message: 'Não foi possível enviar seu relato. Tente novamente.' };
  return { success: true as const, message: 'Obrigado! Recebemos seu relato.' };
}
