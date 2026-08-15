"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const couponSchema = z
  .object({
    id: z.string().uuid().optional(),
    event_id: z.string().uuid(),
    code: z.string().trim().min(1, "Informe o código."),
    coupon_type: z.enum(["courtesy", "percentage"]),
    discount_percent: z.number().min(0),
    max_uses: z.number().int().positive().optional().nullable(),
    valid_from: z.string().optional().nullable(),
    valid_until: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    is_active: z.boolean().default(true),
  })
  .superRefine((value, ctx) => {
    if (value.coupon_type === "courtesy" && value.discount_percent !== 100) {
      ctx.addIssue({ code: "custom", path: ["discount_percent"], message: "Cortesia deve ter 100%." });
    }
    if (value.coupon_type === "percentage" && (value.discount_percent <= 0 || value.discount_percent > 100)) {
      ctx.addIssue({ code: "custom", path: ["discount_percent"], message: "Percentual deve ser maior que 0 e menor ou igual a 100." });
    }
  });

type CouponPayload = z.infer<typeof couponSchema>;

type ActionResult = { success: boolean; message: string };

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? new Date(trimmed).toISOString() : null;
}

async function assertCouponEventAccess(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  eventId: string,
) {
  const { data, error } = await supabase.from("events").select("id").eq("id", eventId).is("archived_at", null).maybeSingle();
  if (error || !data?.id) throw new Error("Evento inválido ou sem acesso para gerenciar cupons.");
}

export async function createCouponAction(payload: CouponPayload): Promise<ActionResult> {
  const parsed = couponSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    await assertCouponEventAccess(supabase, parsed.data.event_id);
    const { error } = await supabase.rpc("create_coupon", {
      p_event_id: parsed.data.event_id,
      p_code: parsed.data.code,
      p_coupon_type: parsed.data.coupon_type,
      p_discount_percent: parsed.data.discount_percent,
      p_max_uses: parsed.data.max_uses ?? null,
      p_valid_from: parseTimestamp(parsed.data.valid_from),
      p_valid_until: parseTimestamp(parsed.data.valid_until),
      p_notes: parsed.data.notes ?? null,
      p_is_active: parsed.data.is_active,
    });

    if (error) throw error;
    revalidatePath("/cupons");
    return { success: true, message: "Cupom criado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao criar cupom." };
  }
}

export async function updateCouponAction(payload: CouponPayload): Promise<ActionResult> {
  const parsed = couponSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.id) {
    return { success: false, message: "Dados inválidos para atualização." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    await assertCouponEventAccess(supabase, parsed.data.event_id);
    const { error } = await supabase.rpc("update_coupon", {
      p_coupon_id: parsed.data.id,
      p_event_id: parsed.data.event_id,
      p_code: parsed.data.code,
      p_coupon_type: parsed.data.coupon_type,
      p_discount_percent: parsed.data.discount_percent,
      p_max_uses: parsed.data.max_uses ?? null,
      p_valid_from: parseTimestamp(parsed.data.valid_from),
      p_valid_until: parseTimestamp(parsed.data.valid_until),
      p_notes: parsed.data.notes ?? null,
      p_is_active: parsed.data.is_active,
    });

    if (error) throw error;
    revalidatePath("/cupons");
    return { success: true, message: "Cupom atualizado com sucesso." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao atualizar cupom." };
  }
}

export async function toggleCouponAction(payload: { id: string; event_id: string; is_active: boolean }): Promise<ActionResult> {
  try {
    const supabase = await createServerSupabaseClient();
    await assertCouponEventAccess(supabase, payload.event_id);
    const { error } = await supabase.rpc("toggle_coupon_active", {
      p_coupon_id: payload.id,
      p_event_id: payload.event_id,
      p_is_active: payload.is_active,
    });

    if (error) throw error;
    revalidatePath("/cupons");
    return { success: true, message: payload.is_active ? "Cupom ativado." : "Cupom desativado." };
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : "Falha ao alterar status do cupom." };
  }
}
