"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";

type ActionResult = {
  success: boolean;
  message: string;
  code?: string | null;
};

export type InventoryMovementItem = {
  id: string;
  movement_type: string;
  quantity: number;
  notes: string | null;
  created_at: string;
};

type InventoryHistoryResult = {
  success: boolean;
  message: string;
  code?: string | null;
  movements: InventoryMovementItem[];
};

type SupabaseActionError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

const addInventorySchema = z.object({
  inventory_id: z.string().uuid("ID inválido."),
  quantity: z.number().int().positive("A quantidade precisa ser maior que zero."),
  notes: z.string().trim().max(300, "A observação deve ter no máximo 300 caracteres.").optional().or(z.literal("")),
});

const adjustInventorySchema = z.object({
  inventory_id: z.string().uuid("ID inválido."),
  quantity: z
    .number()
    .int("A quantidade deve ser um inteiro.")
    .refine((value) => value !== 0, "A quantidade deve ser diferente de zero."),
  notes: z
    .string()
    .trim()
    .min(3, "O motivo do ajuste é obrigatório.")
    .max(300, "A observação deve ter no máximo 300 caracteres."),
});

const historySchema = z.object({
  event_id: z.string().uuid("ID inválido."),
  inventory_id: z.string().uuid("ID inválido."),
});

const setLimitSchema = z.object({
  event_id: z.string().uuid("ID inválido."),
  enabled: z.boolean(),
});

const resetInventorySchema = z.object({
  event_id: z.string().uuid("ID inválido."),
  clear_history: z.boolean().default(false),
  reason: z.string().trim().min(3, "Informe um motivo com pelo menos 3 caracteres.").max(500, "Motivo muito longo."),
  event_name_confirmation: z.string().trim().min(1, "Digite o nome do evento para confirmar."),
});

const isDevelopment = process.env.NODE_ENV !== "production";

function getSupabaseError(error: unknown): SupabaseActionError | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const maybeError = error as Record<string, unknown>;
  return {
    message: typeof maybeError.message === "string" ? maybeError.message : undefined,
    code: typeof maybeError.code === "string" ? maybeError.code : undefined,
    details: typeof maybeError.details === "string" ? maybeError.details : undefined,
    hint: typeof maybeError.hint === "string" ? maybeError.hint : undefined,
  };
}

function getActionErrorResult(error: unknown, fallbackMessage: string): ActionResult {
  const supabaseError = getSupabaseError(error);
  if (isDevelopment && supabaseError?.message) {
    const code = supabaseError.code ? ` (code: ${supabaseError.code})` : "";
    return {
      success: false,
      message: `${supabaseError.message}${code}`,
      code: supabaseError.code ?? null,
    };
  }

  if (error instanceof Error) {
    return { success: false, message: error.message };
  }

  return { success: false, message: fallbackMessage };
}

function sanitizeNotes(notes: string | undefined): string | null {
  const trimmed = notes?.trim();
  return trimmed ? trimmed : null;
}

function revalidateInventoryPages(eventId: string) {
  revalidatePath("/camisetas");
  revalidatePath(`/painel/eventos/${eventId}`);
  revalidatePath("/inscricao");
}

export async function addInventoryQuantityAction(payload: {
  event_id: string;
  inventory_id: string;
  quantity: number;
  notes?: string;
}): Promise<ActionResult> {
  await assertPermission("inventory.add_order");

  const parsed = addInventorySchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("add_inventory_quantity", {
      p_event_id: payload.event_id,
      p_inventory_id: parsed.data.inventory_id,
      p_quantity: parsed.data.quantity,
      p_notes: sanitizeNotes(parsed.data.notes),
    });

    if (error) {
      throw error;
    }

    revalidateInventoryPages(payload.event_id);
    return { success: true, message: "Encomenda adicionada com sucesso." };
  } catch (error) {
    const supabaseError = getSupabaseError(error);
    console.error("ERRO AO ADICIONAR ENCOMENDA:", {
      message: supabaseError?.message,
      code: supabaseError?.code,
      details: supabaseError?.details,
      hint: supabaseError?.hint,
    });

    return getActionErrorResult(error, "Não foi possível adicionar a encomenda.");
  }
}

export async function adjustInventoryQuantityAction(payload: {
  event_id: string;
  inventory_id: string;
  quantity: number;
  notes: string;
}): Promise<ActionResult> {
  await assertPermission("inventory.adjust");

  const parsed = adjustInventorySchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("adjust_inventory_quantity", {
      p_event_id: payload.event_id,
      p_inventory_id: parsed.data.inventory_id,
      p_quantity_delta: parsed.data.quantity,
      p_notes: sanitizeNotes(parsed.data.notes),
    });

    if (error) {
      throw error;
    }

    revalidateInventoryPages(payload.event_id);
    return { success: true, message: "Ajuste de estoque aplicado com sucesso." };
  } catch (error) {
    return getActionErrorResult(error, "Não foi possível ajustar o estoque.");
  }
}

export async function getInventoryMovementsAction(payload: {
  event_id: string;
  inventory_id: string;
}): Promise<InventoryHistoryResult> {
  await assertPermission("inventory.view_history");

  const parsed = historySchema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "ID inválido.",
      movements: [],
    };
  }

  try {
    const supabase = await createServerSupabaseClient();

    const { data: inventoryRow, error: inventoryError } = await supabase
      .from("shirt_inventory")
      .select("id")
      .eq("id", parsed.data.inventory_id)
      .eq("event_id", parsed.data.event_id)
      .maybeSingle();

    if (inventoryError) {
      throw inventoryError;
    }

    if (!inventoryRow?.id) {
      return { success: false, message: "Linha de estoque não encontrada no evento ativo.", movements: [] };
    }

    const { data, error } = await supabase
      .from("inventory_movements")
      .select("id, movement_type, quantity, notes, created_at")
      .eq("inventory_id", parsed.data.inventory_id)
      .eq("event_id", parsed.data.event_id)
      .order("created_at", { ascending: false })
      .limit(30);

    if (error) {
      throw error;
    }

    return {
      success: true,
      message: "Histórico carregado com sucesso.",
      movements: (data ?? []) as InventoryMovementItem[],
    };
  } catch (error) {
    const result = getActionErrorResult(error, "Não foi possível carregar o histórico.");
    return {
      success: false,
      message: result.message,
      code: result.code,
      movements: [],
    };
  }
}

export async function setEventShirtStockLimitAction(payload: {
  event_id: string;
  enabled: boolean;
}): Promise<ActionResult> {
  await assertPermission("inventory.limit_selection");

  const parsed = setLimitSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("set_event_shirt_stock_limit", {
      p_event_id: parsed.data.event_id,
      p_enabled: parsed.data.enabled,
    });

    if (error) throw error;

    revalidateInventoryPages(parsed.data.event_id);

    return {
      success: true,
      message: parsed.data.enabled
        ? "Limitação por estoque físico ativada."
        : "Limitação por estoque físico desativada.",
    };
  } catch (error) {
    return getActionErrorResult(error, "Não foi possível atualizar a configuração de estoque.");
  }
}

export async function resetEventShirtInventoryAction(payload: {
  event_id: string;
  clear_history: boolean;
  reason: string;
  event_name_confirmation: string;
}): Promise<ActionResult & { details?: Record<string, unknown> }> {
  const parsed = resetInventorySchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  if (parsed.data.clear_history) {
    await assertPermission("inventory.clear_history");
  } else {
    await assertPermission("inventory.reset");
  }

  try {
    const supabase = await createServerSupabaseClient();

    const { data: eventData, error: eventError } = await supabase
      .from("events")
      .select("id, name, year")
      .eq("id", parsed.data.event_id)
      .maybeSingle();

    if (eventError) throw eventError;
    if (!eventData?.id) {
      return { success: false, message: "Evento não encontrado." };
    }

    const expectedLabel = `${String(eventData.name ?? "").trim()}${eventData.year ? ` ${Number(eventData.year)}` : ""}`.trim();
    if (parsed.data.event_name_confirmation.trim() !== expectedLabel) {
      return {
        success: false,
        message: `Confirmação inválida. Digite exatamente: ${expectedLabel}`,
      };
    }

    if (parsed.data.clear_history && process.env.NODE_ENV === "production") {
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user?.id) {
        return { success: false, message: "Sessão expirada. Entre novamente." };
      }

      const { data: isOwner, error: ownerError } = await supabase.rpc("is_active_owner", {
        p_user_id: user.id,
      });

      if (ownerError) throw ownerError;
      if (!Boolean(isOwner)) {
        return { success: false, message: "Em produção, apenas Owner pode limpar histórico de estoque." };
      }
    }

    const { data, error } = await supabase.rpc("reset_event_shirt_inventory", {
      p_event_id: parsed.data.event_id,
      p_clear_history: parsed.data.clear_history,
      p_reason: parsed.data.reason,
    });

    if (error) throw error;

    revalidateInventoryPages(parsed.data.event_id);

    return {
      success: true,
      message: parsed.data.clear_history
        ? "Estoque zerado e histórico limpo para este evento."
        : "Estoque zerado para este evento (histórico preservado).",
      details: (data ?? {}) as Record<string, unknown>,
    };
  } catch (error) {
    return getActionErrorResult(error, "Não foi possível executar a zeragem de estoque.");
  }
}
