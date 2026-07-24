"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";

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
  notes: z.string().trim().max(300, "A observação deve ter no máximo 300 caracteres.").optional().or(z.literal("")),
});

const historySchema = z.object({
  inventory_id: z.string().uuid("ID inválido."),
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

export async function addInventoryQuantityAction(payload: {
  inventory_id: string;
  quantity: number;
  notes?: string;
}): Promise<ActionResult> {
  const parsed = addInventorySchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("add_inventory_quantity", {
      p_inventory_id: parsed.data.inventory_id,
      p_quantity: parsed.data.quantity,
      p_notes: sanitizeNotes(parsed.data.notes),
    });

    if (error) {
      throw error;
    }

    revalidatePath("/camisetas");
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
  inventory_id: string;
  quantity: number;
  notes?: string;
}): Promise<ActionResult> {
  const parsed = adjustInventorySchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { error } = await supabase.rpc("adjust_inventory_quantity", {
      p_inventory_id: parsed.data.inventory_id,
      p_quantity: parsed.data.quantity,
      p_notes: sanitizeNotes(parsed.data.notes),
    });

    if (error) {
      throw error;
    }

    revalidatePath("/camisetas");
    return { success: true, message: "Ajuste de estoque aplicado com sucesso." };
  } catch (error) {
    return getActionErrorResult(error, "Não foi possível ajustar o estoque.");
  }
}

export async function getInventoryMovementsAction(payload: {
  inventory_id: string;
}): Promise<InventoryHistoryResult> {
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

    const { data: activeEvent, error: activeEventError } = await supabase
      .from("events")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();

    if (activeEventError) {
      throw activeEventError;
    }

    if (!activeEvent?.id) {
      return { success: false, message: "Nenhum evento ativo encontrado.", movements: [] };
    }

    const { data: inventoryRow, error: inventoryError } = await supabase
      .from("shirt_inventory")
      .select("id")
      .eq("id", parsed.data.inventory_id)
      .eq("event_id", activeEvent.id)
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
      .eq("event_id", activeEvent.id)
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
