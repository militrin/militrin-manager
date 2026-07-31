"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const batchSchema = z.object({
  id: z.string().uuid().optional(),
  event_id: z.string().uuid(),
  name: z.string().optional().nullable(),
  max_confirmed_registrations: z.number().int().positive("Limite deve ser maior que zero."),
  starts_at: z.string().optional().nullable(),
  ends_at: z.string().optional().nullable(),
  is_active: z.boolean().default(false),
  category_prices: z.array(z.object({
    ticket_category_id: z.string().uuid(),
    enabled: z.boolean(),
    male_price: z.number().min(0, "Preco masculino por categoria invalido."),
    female_price: z.number().min(0, "Preco feminino por categoria invalido."),
  })).default([]),
}).superRefine((data, ctx) => {
  const enabled = data.category_prices.filter((item) => item.enabled);
  if (enabled.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["category_prices"],
      message: "Ative pelo menos uma categoria no lote.",
    });
  }

  enabled.forEach((item, index) => {
    if (!Number.isFinite(item.male_price) || item.male_price < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category_prices", index, "male_price"],
        message: "Preco masculino por categoria deve ser maior ou igual a zero.",
      });
    }
    if (!Number.isFinite(item.female_price) || item.female_price < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["category_prices", index, "female_price"],
        message: "Preco feminino por categoria deve ser maior ou igual a zero.",
      });
    }
  });

  if (data.starts_at && data.ends_at) {
    const startsAt = new Date(data.starts_at).getTime();
    const endsAt = new Date(data.ends_at).getTime();
    if (!Number.isNaN(startsAt) && !Number.isNaN(endsAt) && endsAt < startsAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ends_at"],
        message: "Data final nao pode ser anterior a data inicial.",
      });
    }
  }
});

type BatchPayload = z.infer<typeof batchSchema>;

type ActionResult = { success: boolean; message: string };

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? new Date(trimmed).toISOString() : null;
}

export async function createBatchAction(payload: BatchPayload): Promise<ActionResult> {
  const parsed = batchSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados invalidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("create_registration_batch_with_prices", {
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name?.trim() || null,
      p_max_confirmed_registrations: parsed.data.max_confirmed_registrations,
      p_starts_at: parseTimestamp(parsed.data.starts_at),
      p_ends_at: parseTimestamp(parsed.data.ends_at),
      p_is_active: parsed.data.is_active,
      p_prices: parsed.data.category_prices,
    });

    if (error) throw error;

    revalidatePath("/lotes");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);

    return { success: true, message: "Lote criado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao criar lote." };
  }
}

export async function updateBatchAction(payload: BatchPayload): Promise<ActionResult> {
  const parsed = batchSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.id) {
    return { success: false, message: "Dados invalidos para atualizacao." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("update_registration_batch_with_prices", {
      p_batch_id: parsed.data.id,
      p_event_id: parsed.data.event_id,
      p_name: parsed.data.name?.trim() || null,
      p_max_confirmed_registrations: parsed.data.max_confirmed_registrations,
      p_starts_at: parseTimestamp(parsed.data.starts_at),
      p_ends_at: parseTimestamp(parsed.data.ends_at),
      p_is_active: parsed.data.is_active,
      p_prices: parsed.data.category_prices,
    });

    if (error) throw error;

    revalidatePath("/lotes");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${parsed.data.event_id}`);

    return { success: true, message: "Lote atualizado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao atualizar lote." };
  }
}

export async function activateBatchAction(payload: { id: string; event_id: string }): Promise<ActionResult> {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("activate_registration_batch", {
      p_batch_id: payload.id,
      p_event_id: payload.event_id,
    });

    if (error) throw error;

    revalidatePath("/lotes");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${payload.event_id}`);

    return { success: true, message: "Lote ativado." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao ativar lote." };
  }
}

export async function deleteBatchAction(payload: { id: string; event_id: string }): Promise<ActionResult> {
  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("delete_registration_batch", {
      p_batch_id: payload.id,
      p_event_id: payload.event_id,
    });

    if (error) throw error;

    revalidatePath("/lotes");
    revalidatePath("/inscricoes/nova");
    revalidatePath(`/painel/eventos/${payload.event_id}`);

    return { success: true, message: "Lote removido." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao remover lote." };
  }
}
