"use server";

import { z } from "zod";
import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const couponSchema = z
  .object({
    id: z.string().uuid().optional(),
    organization_id: z.string().uuid(),
    code: z.string().trim().min(1, "Informe o código."),
    discount_type: z.enum(["percentage", "fixed"]),
    discount_value: z.number(),
    applies_to_tickets: z.boolean(),
    applies_to_products: z.boolean(),
    max_uses: z.number().int().positive().optional().nullable(),
    valid_from: z.string().optional().nullable(),
    valid_until: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    is_active: z.boolean().default(true),
    event_ids: z.array(z.string().uuid()).default([]),
    ticket_category_ids: z.array(z.string().uuid()).default([]),
    store_item_ids: z.array(z.string().uuid()).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.applies_to_tickets && !value.applies_to_products) {
      ctx.addIssue({ code: "custom", path: ["applies_to_tickets"], message: "Selecione ao menos um escopo: ingressos e/ou produtos." });
    }
    if (value.discount_type === "percentage" && (value.discount_value <= 0 || value.discount_value > 100)) {
      ctx.addIssue({ code: "custom", path: ["discount_value"], message: "Percentual deve ser maior que 0 e menor ou igual a 100." });
    }
    if (value.discount_type === "fixed" && value.discount_value <= 0) {
      ctx.addIssue({ code: "custom", path: ["discount_value"], message: "Valor fixo deve ser maior que zero." });
    }
  });

type CouponPayload = z.infer<typeof couponSchema>;
type ActionResult = { success: boolean; message: string };

function parseTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed ? new Date(trimmed).toISOString() : null;
}

export async function createCouponAction(payload: CouponPayload): Promise<ActionResult> {
  const parsed = couponSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("create_organization_coupon", {
    p_organization_id: parsed.data.organization_id,
    p_code: parsed.data.code,
    p_discount_type: parsed.data.discount_type,
    p_discount_value: parsed.data.discount_value,
    p_applies_to_tickets: parsed.data.applies_to_tickets,
    p_applies_to_products: parsed.data.applies_to_products,
    p_max_uses: parsed.data.max_uses ?? null,
    p_valid_from: parseTimestamp(parsed.data.valid_from),
    p_valid_until: parseTimestamp(parsed.data.valid_until),
    p_notes: parsed.data.notes ?? null,
    p_is_active: parsed.data.is_active,
    p_event_ids: parsed.data.event_ids,
    p_ticket_category_ids: parsed.data.ticket_category_ids,
    p_store_item_ids: parsed.data.store_item_ids,
  });
  if (error) return { success: false, message: error.message };
  revalidatePath("/cupons");
  return { success: true, message: "Cupom criado com sucesso." };
}

export async function updateCouponAction(payload: CouponPayload): Promise<ActionResult> {
  const parsed = couponSchema.safeParse(payload);
  if (!parsed.success || !parsed.data.id) {
    return { success: false, message: parsed.success ? "Dados inválidos para atualização." : parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("update_organization_coupon", {
    p_coupon_id: parsed.data.id,
    p_code: parsed.data.code,
    p_discount_type: parsed.data.discount_type,
    p_discount_value: parsed.data.discount_value,
    p_applies_to_tickets: parsed.data.applies_to_tickets,
    p_applies_to_products: parsed.data.applies_to_products,
    p_max_uses: parsed.data.max_uses ?? null,
    p_valid_from: parseTimestamp(parsed.data.valid_from),
    p_valid_until: parseTimestamp(parsed.data.valid_until),
    p_notes: parsed.data.notes ?? null,
    p_is_active: parsed.data.is_active,
    p_event_ids: parsed.data.event_ids,
    p_ticket_category_ids: parsed.data.ticket_category_ids,
    p_store_item_ids: parsed.data.store_item_ids,
  });
  if (error) return { success: false, message: error.message };
  revalidatePath("/cupons");
  return { success: true, message: "Cupom atualizado com sucesso." };
}

export async function toggleCouponAction(payload: { id: string; is_active: boolean }): Promise<ActionResult> {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("set_coupon_active", { p_coupon_id: payload.id, p_is_active: payload.is_active });
  if (error) return { success: false, message: error.message };
  revalidatePath("/cupons");
  return { success: true, message: payload.is_active ? "Cupom ativado." : "Cupom desativado." };
}

export async function deleteOrArchiveCouponAction(couponId: string): Promise<ActionResult & { action?: "deleted" | "archived" }> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("delete_or_archive_coupon", { p_coupon_id: couponId });
  if (error) return { success: false, message: error.message };
  const action = (data as { action?: "deleted" | "archived" } | null)?.action;
  revalidatePath("/cupons");
  return {
    success: true,
    action,
    message: action === "archived" ? "Cupom já utilizado em pedidos — arquivado (não fica mais disponível para novas compras)." : "Cupom excluído definitivamente.",
  };
}

export async function getCouponScopeOptionsAction(organizationId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_organization_coupon_scope_options", { p_organization_id: organizationId });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, options: data as { events: Array<{ id: string; name: string; year: number | null }>; ticket_categories: Array<{ id: string; name: string; event_id: string }>; store_items: Array<{ id: string; name: string; price: number; image_url: string | null; is_active: boolean }> } };
}

export async function getCouponDetailsAction(couponId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("get_organization_coupon_details", { p_coupon_id: couponId });
  if (error) return { success: false as const, message: error.message };
  return { success: true as const, coupon: data as Record<string, unknown> };
}
