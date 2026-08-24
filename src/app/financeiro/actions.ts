"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";

export type FinancialActionState = { success: boolean; message: string; id?: string };
const fail = (message: string): FinancialActionState => ({ success: false, message });
const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
const optional = (form: FormData, key: string) => value(form, key) || null;
const amount = (form: FormData, key = "amount") => Number(value(form, key).replace(",", "."));

async function call(rpc: string, args: Record<string, unknown>): Promise<FinancialActionState> {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc(rpc, args);
  if (error) return fail(error.message || "Não foi possível concluir a operação financeira.");
  revalidatePath("/financeiro");
  return { success: true, message: "Operação concluída.", id: data ? String(data) : undefined };
}

export async function upsertFinancialAccountAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_accounts");
  return call("upsert_financial_account", {
    p_organization_id: value(form, "organizationId"), p_account_id: optional(form, "accountId"),
    p_code: value(form, "code"), p_name: value(form, "name"), p_account_type: value(form, "accountType"),
    p_is_active: value(form, "isActive") !== "false", p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function initializeSimpleFinanceAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_accounts");
  return call("ensure_simple_financial_accounts", {
    p_organization_id: value(form, "organizationId"), p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function createSimpleFinancialExpenseAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_expenses");
  const total = amount(form);
  if (!Number.isFinite(total) || total <= 0) return fail("Informe um valor positivo.");
  return call("create_simple_financial_expense", {
    p_organization_id: value(form, "organizationId"), p_description: value(form, "description"),
    p_amount: total, p_due_date: value(form, "dueDate"), p_occurred_on: optional(form, "occurredOn"),
    p_category_id: optional(form, "categoryId"), p_supplier_id: optional(form, "supplierId"),
    p_event_id: optional(form, "eventId"), p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function settleSimpleFinancialExpenseAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.confirm_payment");
  const total = amount(form);
  if (!Number.isFinite(total) || total <= 0) return fail("Informe o valor pago.");
  return call("settle_simple_financial_expense", {
    p_entry_id: value(form, "entryId"), p_amount: total, p_paid_on: value(form, "paidOn"),
    p_reason: value(form, "reason"), p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function upsertFinancialCategoryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_categories");
  return call("upsert_financial_category", {
    p_organization_id: value(form, "organizationId"), p_category_id: optional(form, "categoryId"),
    p_name: value(form, "name"), p_entry_kind: value(form, "entryKind"),
    p_is_active: value(form, "isActive") !== "false", p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function removeFinancialCategoryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_categories");
  return call("remove_financial_category", {
    p_organization_id: value(form, "organizationId"), p_category_id: value(form, "categoryId"),
    p_reason: value(form, "reason"), p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function upsertFinancialSupplierAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_suppliers");
  return call("upsert_financial_supplier", {
    p_organization_id: value(form, "organizationId"), p_supplier_id: optional(form, "supplierId"),
    p_legal_name: value(form, "legalName"), p_display_name: optional(form, "displayName"),
    p_tax_identifier: optional(form, "taxIdentifier"), p_is_active: value(form, "isActive") !== "false",
    p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function removeFinancialSupplierAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_suppliers");
  return call("remove_financial_supplier", {
    p_organization_id: value(form, "organizationId"), p_supplier_id: value(form, "supplierId"),
    p_reason: value(form, "reason"), p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function createFinancialEntryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_entries");
  const total = amount(form);
  if (!Number.isFinite(total) || total <= 0) return fail("Informe um valor positivo.");
  const allocations = optional(form, "eventId")
    ? [{ event_id: value(form, "eventId"), amount: total }]
    : [];
  return call("create_financial_entry", {
    p_organization_id: value(form, "organizationId"), p_entry_kind: value(form, "entryKind"),
    p_description: value(form, "description"), p_amount: total, p_due_date: optional(form, "dueDate"),
    p_occurred_on: optional(form, "occurredOn"), p_category_id: optional(form, "categoryId"),
    p_supplier_id: optional(form, "supplierId"), p_source_payment_id: null,
    p_lines: [
      { account_id: value(form, "debitAccountId"), side: "debit", amount: total },
      { account_id: value(form, "creditAccountId"), side: "credit", amount: total },
    ],
    p_allocations: allocations, p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function postFinancialEntryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.manage_entries");
  return call("post_financial_entry", { p_entry_id: value(form, "entryId"), p_reason: optional(form, "reason") });
}

export async function reconcileFinancialEntryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.reconcile");
  return call("reconcile_financial_entry", {
    p_entry_id: value(form, "entryId"), p_account_id: value(form, "accountId"), p_amount: amount(form),
    p_reconciled_on: value(form, "reconciledOn"), p_external_reference: optional(form, "externalReference"),
    p_idempotency_key: value(form, "idempotencyKey"),
  });
}

export async function reverseFinancialEntryAction(_: FinancialActionState, form: FormData) {
  await assertPermission("finance.refund");
  return call("reverse_financial_entry", {
    p_entry_id: value(form, "entryId"), p_amount: amount(form), p_reason: value(form, "reason"),
    p_idempotency_key: value(form, "idempotencyKey"),
  });
}
