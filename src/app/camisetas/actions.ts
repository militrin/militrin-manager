"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { resolveOperatorNames } from "@/lib/admin/operator-names";
import { getShirtSizeOrder, getShirtTypeOrder } from "@/lib/constants/shirts";
import { dateTimePartsInEventTimeZone } from "@/lib/utils/date";

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

export type InventoryReceiptItem = {
  inventory_id: string;
  shirt_type: string;
  shirt_size: string;
  quantity: number;
};

export type InventoryReceiptRecord = {
  id: string;
  description: string;
  ordered_at: string | null;
  received_at: string;
  supplier: string | null;
  notes: string | null;
  status: string;
  origin: string;
  created_by: string | null;
  created_at: string;
  operator_label: string;
  total_quantity: number;
  items: InventoryReceiptItem[];
};

type InventoryReceiptListResult = {
  success: boolean;
  message: string;
  code?: string | null;
  receipts: InventoryReceiptRecord[];
};

type SupabaseActionError = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

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

const createReceiptSchema = z
  .object({
    event_id: z.string().uuid("ID inválido."),
    idempotency_key: z.string().uuid("Chave de idempotência inválida."),
    description: z.string().trim().min(1, "A descrição é obrigatória.").max(200, "A descrição deve ter no máximo 200 caracteres."),
    received_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data de recebimento inválida."),
    ordered_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Data do pedido inválida.")
      .optional()
      .or(z.literal("")),
    supplier: z.string().trim().max(200, "Fornecedor deve ter no máximo 200 caracteres.").optional().or(z.literal("")),
    notes: z.string().trim().max(500, "A observação deve ter no máximo 500 caracteres.").optional().or(z.literal("")),
    items: z
      .array(
        z.object({
          inventory_id: z.string().uuid("ID inválido."),
          quantity: z
            .number()
            .int("A quantidade deve ser um inteiro.")
            .nonnegative("A quantidade não pode ser negativa.")
            .max(2147483647, "Quantidade excede o limite."),
        }),
      )
      .min(1, "Informe ao menos uma quantidade."),
  })
  .superRefine((value, ctx) => {
    const parts = dateTimePartsInEventTimeZone(new Date());
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    if (value.received_at > today) {
      ctx.addIssue({ code: "custom", path: ["received_at"], message: "Data de recebimento não pode ser futura." });
    }
    if (value.ordered_at && value.ordered_at > value.received_at) {
      ctx.addIssue({ code: "custom", path: ["ordered_at"], message: "Data do pedido não pode ser posterior ao recebimento." });
    }
  });

const eventHistorySchema = z.object({
  event_id: z.string().uuid("ID inválido."),
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

function sortReceiptItems(items: InventoryReceiptItem[]): InventoryReceiptItem[] {
  return [...items].sort((a, b) => {
    const typeDiff = getShirtTypeOrder(a.shirt_type) - getShirtTypeOrder(b.shirt_type);
    if (typeDiff !== 0) return typeDiff;
    return getShirtSizeOrder(a.shirt_size) - getShirtSizeOrder(b.shirt_size);
  });
}

function receiptOperatorLabel(origin: string, createdBy: string | null, names: Map<string, string>): string {
  if (origin === "historical_backfill" || !createdBy) {
    return "Registro histórico";
  }
  return names.get(createdBy) ?? "Operador não identificado";
}

function revalidateInventoryPages(eventId: string) {
  revalidatePath("/camisetas");
  revalidatePath(`/painel/eventos/${eventId}`);
  revalidatePath("/inscricao");
}

export async function createInventoryReceiptAction(payload: {
  event_id: string;
  idempotency_key: string;
  description: string;
  received_at: string;
  ordered_at?: string;
  supplier?: string;
  notes?: string;
  items: Array<{ inventory_id: string; quantity: number }>;
}): Promise<ActionResult & { receipt_id?: string | null }> {
  await assertPermission("inventory.adjust");

  const parsed = createReceiptSchema.safeParse(payload);
  if (!parsed.success) {
    return { success: false, message: parsed.error.issues[0]?.message ?? "Dados inválidos." };
  }

  const items = parsed.data.items.filter((item) => item.quantity > 0);
  if (items.length === 0) {
    return { success: false, message: "Informe ao menos uma quantidade maior que zero." };
  }

  const inventoryIds = new Set(items.map((item) => item.inventory_id));
  if (inventoryIds.size !== items.length) {
    return { success: false, message: "Item duplicado na entrada." };
  }

  const totalPieces = items.reduce((sum, item) => sum + item.quantity, 0);
  if (totalPieces > 2147483647) {
    return { success: false, message: "Quantidade total excede o limite." };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("create_inventory_receipt", {
      p_event_id: parsed.data.event_id,
      p_description: parsed.data.description,
      p_received_at: parsed.data.received_at,
      p_ordered_at: parsed.data.ordered_at ? parsed.data.ordered_at : null,
      p_supplier: sanitizeNotes(parsed.data.supplier),
      p_notes: sanitizeNotes(parsed.data.notes),
      p_items: items,
      p_idempotency_key: parsed.data.idempotency_key,
    });

    if (error) {
      throw error;
    }

    revalidateInventoryPages(parsed.data.event_id);
    return {
      success: true,
      message: "Entrada registrada com sucesso.",
      receipt_id: typeof data === "string" ? data : null,
    };
  } catch (error) {
    return getActionErrorResult(error, "Não foi possível registrar a entrada.");
  }
}

export async function listEventInventoryReceiptsAction(payload: {
  event_id: string;
}): Promise<InventoryReceiptListResult> {
  await assertPermission("inventory.view_history");

  const parsed = eventHistorySchema.safeParse(payload);
  if (!parsed.success) {
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? "ID inválido.",
      receipts: [],
    };
  }

  try {
    const supabase = await createServerSupabaseClient();
    const { data, error } = await supabase.rpc("list_event_inventory_receipts", {
      p_event_id: parsed.data.event_id,
    });

    if (error) {
      throw error;
    }

    const rawReceipts = Array.isArray(data) ? data : [];
    const receipts = rawReceipts.map((row) => {
      const record = (row ?? {}) as Record<string, unknown>;
      const items = Array.isArray(record.items)
        ? (record.items as Array<Record<string, unknown>>).map((item) => ({
            inventory_id: String(item.inventory_id ?? ""),
            shirt_type: String(item.shirt_type ?? ""),
            shirt_size: String(item.shirt_size ?? ""),
            quantity: Number(item.quantity ?? 0),
          }))
        : [];
      return {
        id: String(record.id ?? ""),
        description: String(record.description ?? ""),
        ordered_at: record.ordered_at ? String(record.ordered_at) : null,
        received_at: String(record.received_at ?? ""),
        supplier: record.supplier ? String(record.supplier) : null,
        notes: record.notes ? String(record.notes) : null,
        status: String(record.status ?? "posted"),
        origin: String(record.origin ?? "live"),
        created_by: record.created_by ? String(record.created_by) : null,
        created_at: String(record.created_at ?? ""),
        operator_label: "",
        total_quantity: Number(record.total_quantity ?? 0),
        items: sortReceiptItems(items),
      } satisfies InventoryReceiptRecord;
    });

    const names = await resolveOperatorNames(receipts.map((receipt) => receipt.created_by).filter((id): id is string => Boolean(id)));
    return {
      success: true,
      message: "Histórico de entradas carregado.",
      receipts: receipts.map((receipt) => ({
        ...receipt,
        operator_label: receiptOperatorLabel(receipt.origin, receipt.created_by, names),
      })),
    };
  } catch (error) {
    const result = getActionErrorResult(error, "Não foi possível carregar o histórico de entradas.");
    return {
      success: false,
      message: result.message,
      code: result.code,
      receipts: [],
    };
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
