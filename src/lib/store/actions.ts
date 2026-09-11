"use server";

import { revalidatePath } from "next/cache";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { ACCOUNT_NOT_CONFIRMED_MESSAGE, isEmailConfirmed } from "@/lib/account/email-confirmation";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import {
  getPaymentGatewayAccountKeyForMethod,
  getPaymentGatewayProviderForMethod,
  getPaymentGatewayProviderName,
} from "@/lib/payments/get-gateway-provider";
import { getAsaasAccountCredentialsForMethod } from "@/lib/payments/asaas-account-registry";
import { todayAsPixDueDate } from "@/lib/payments/pix-due-date";
import { isProductionPaymentRuntime, STORE_PAYMENT_UNAVAILABLE_MESSAGE } from "@/lib/payments/production-runtime";
import { isSyntheticGatewayPayload } from "@/lib/payments/synthetic-gateway-payload";
import { appBaseUrl } from "@/lib/urls/app-base-url";
import type { PaymentGatewayProvider } from "@/lib/payments/provider";
import type { AsaasCheckoutMethod } from "@/lib/payments/asaas-account-registry";

export type StoreCartLine = { storeItemId: string; variantId: string | null; quantity: number };

export type StoreCheckoutPayment = {
  storeOrderId: string;
  orderNumber: string;
  finalAmount: number;
  paymentMethod: "pix" | "credit_card";
  pixCode: string | null;
  pixQrCode: string | null;
  checkoutUrl: string | null;
  expiresAt: string | null;
  status: "awaiting_payment" | "paid";
};

const UNAVAILABLE = STORE_PAYMENT_UNAVAILABLE_MESSAGE;

function digits(value: string | null | undefined) {
  return String(value ?? "").replace(/\D/g, "");
}

function assertStoreLiveGateway(method: AsaasCheckoutMethod): PaymentGatewayProvider {
  if (isProductionPaymentRuntime() && getPaymentGatewayProviderName() !== "asaas") {
    throw new Error(UNAVAILABLE);
  }
  try {
    const gateway = getPaymentGatewayProviderForMethod(method);
    if (isProductionPaymentRuntime() && gateway.name !== "asaas") {
      throw new Error(UNAVAILABLE);
    }
    return gateway;
  } catch (error) {
    if (isProductionPaymentRuntime()) {
      console.error("[loja:checkout] gateway_unavailable", error instanceof Error ? error.message : String(error));
      throw new Error(UNAVAILABLE);
    }
    throw error;
  }
}

async function loadStorePayer(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  user: { id: string; email?: string | null },
  storeOrder: { registration_contact_id: string | null; organization_id: string | null },
) {
  let name = "";
  let email = String(user.email ?? "").trim();
  let cpf = "";
  let phone = "";

  if (storeOrder.registration_contact_id) {
    const { data: contact } = await supabase
      .from("registration_contacts")
      .select("full_name, email, cpf, phone")
      .eq("id", storeOrder.registration_contact_id)
      .maybeSingle();
    name = String(contact?.full_name ?? "").trim();
    email = String(contact?.email ?? email).trim();
    cpf = digits(String(contact?.cpf ?? ""));
    phone = String(contact?.phone ?? "").trim();
  }

  if (!name || !cpf) {
    const profile = await supabase.rpc("get_customer_profile", { p_user_id: user.id });
    const row = (Array.isArray(profile.data) ? profile.data[0] : profile.data) as Record<string, unknown> | null;
    if (!name) name = String(row?.full_name ?? "").trim();
    if (!cpf) cpf = digits(String(row?.cpf ?? ""));
    if (!phone) phone = String(row?.phone ?? "").trim();
  }

  return { name, email, cpf, phone, organizationId: String(storeOrder.organization_id ?? "") };
}

async function cancelOrphanStoreCharge(
  gateway: PaymentGatewayProvider,
  input: { organizationId: string; storeOrderId: string; providerPaymentId: string },
) {
  if (gateway.name === "fake" || !input.providerPaymentId) return;
  try {
    await gateway.cancelPayment({
      organizationId: input.organizationId,
      providerPaymentId: input.providerPaymentId,
      reason: "Falha ao persistir cobranca da Loja.",
    });
  } catch (error) {
    console.error("[loja:checkout] orphan_charge_cancel_failed", {
      store_order_id: input.storeOrderId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function rollbackStoreOrder(storeOrderId: string) {
  const supabase = await createServerSupabaseClient();
  await supabase.rpc("cancel_store_order", {
    p_store_order_id: storeOrderId,
    p_reason: "Falha ao iniciar pagamento da Loja",
  });
}

async function persistStoreGatewayCharge(input: {
  storeOrderId: string;
  paymentMethod: "pix" | "credit_card";
  pixCode: string | null;
  pixQrCode: string | null;
  gatewayPaymentId: string;
  expiresAt: string;
  checkoutUrl: string | null;
  provider: string;
  accountKey: string | null;
  environment: "sandbox" | "production" | null;
}) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("start_store_order_payment_pix", {
    p_store_order_id: input.storeOrderId,
    p_pix_code: input.pixCode,
    p_pix_qrcode: input.pixQrCode,
    p_gateway_payment_id: input.gatewayPaymentId,
    p_expires_at: input.expiresAt,
    p_provider: input.provider,
    p_gateway_account_key: input.accountKey,
    p_gateway_environment: input.environment,
    p_checkout_url: input.checkoutUrl,
    p_payment_method: input.paymentMethod,
  });
  if (error) return { success: false as const, message: error.message };
  const order = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
  return {
    success: true as const,
    pixCode: order?.pix_code ? String(order.pix_code) : null,
    pixQrCode: order?.pix_qrcode ? String(order.pix_qrcode) : null,
    checkoutUrl: order?.gateway_checkout_url ? String(order.gateway_checkout_url) : input.checkoutUrl,
    expiresAt: order?.expires_at ? String(order.expires_at) : input.expiresAt,
  };
}

async function startStoreGatewayPayment(input: {
  storeOrderId: string;
  orderNumber: string;
  amount: number;
  paymentMethod: "pix" | "credit_card";
}): Promise<{ success: true; payment: StoreCheckoutPayment } | { success: false; message: string }> {
  let gateway: PaymentGatewayProvider;
  try {
    gateway = assertStoreLiveGateway(input.paymentMethod);
  } catch (error) {
    return { success: false, message: error instanceof Error ? error.message : UNAVAILABLE };
  }

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, message: "Entre na sua conta para continuar a compra." };

  const { data: storeOrder, error: orderError } = await supabase
    .from("store_orders")
    .select("id, user_id, organization_id, registration_contact_id, status, payment_status, final_amount")
    .eq("id", input.storeOrderId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (orderError || !storeOrder) {
    return { success: false, message: orderError?.message ?? "Pedido não encontrado." };
  }
  if (storeOrder.status !== "pending" || storeOrder.payment_status === "paid") {
    return { success: false, message: "Pedido não está pendente de pagamento." };
  }

  const payer = await loadStorePayer(supabase, user, storeOrder);
  if (gateway.name === "asaas" && (!payer.name || !payer.email || !payer.cpf)) {
    return {
      success: false,
      message: "Complete seu nome, e-mail e CPF em Meus dados antes de pagar na Loja.",
    };
  }

  const credentials = gateway.name === "asaas" ? getAsaasAccountCredentialsForMethod(input.paymentMethod) : null;
  const accountKey = credentials?.accountKey ?? getPaymentGatewayAccountKeyForMethod(input.paymentMethod);
  const environment = credentials?.environment ?? null;
  const description = input.orderNumber ? `Loja ${input.orderNumber}` : "Pedido da Loja";

  try {
    if (input.paymentMethod === "pix") {
      const payload = await gateway.createPixPayment({
        organizationId: payer.organizationId,
        orderId: input.storeOrderId,
        paymentId: input.storeOrderId,
        amount: input.amount,
        dueDate: todayAsPixDueDate(),
        payer: { name: payer.name, email: payer.email, cpfCnpj: payer.cpf, phone: payer.phone || undefined },
        description,
      });
      if (
        isProductionPaymentRuntime() &&
        (gateway.name !== "asaas" ||
          isSyntheticGatewayPayload({
            pixCode: payload.pixCode,
            pixQrCode: payload.pixQrCodeImage,
            gatewayPaymentId: payload.providerPaymentId,
            provider: gateway.name,
          }))
      ) {
        await cancelOrphanStoreCharge(gateway, {
          organizationId: payer.organizationId,
          storeOrderId: input.storeOrderId,
          providerPaymentId: payload.providerPaymentId,
        });
        return { success: false, message: UNAVAILABLE };
      }
      const persisted = await persistStoreGatewayCharge({
        storeOrderId: input.storeOrderId,
        paymentMethod: "pix",
        pixCode: payload.pixCode,
        pixQrCode: payload.pixQrCodeImage,
        gatewayPaymentId: payload.providerPaymentId,
        expiresAt: payload.expiresAt,
        checkoutUrl: null,
        provider: gateway.name,
        accountKey,
        environment,
      });
      if (!persisted.success) {
        await cancelOrphanStoreCharge(gateway, {
          organizationId: payer.organizationId,
          storeOrderId: input.storeOrderId,
          providerPaymentId: payload.providerPaymentId,
        });
        return persisted;
      }
      return {
        success: true,
        payment: {
          storeOrderId: input.storeOrderId,
          orderNumber: input.orderNumber,
          finalAmount: input.amount,
          paymentMethod: "pix",
          pixCode: persisted.pixCode,
          pixQrCode: persisted.pixQrCode,
          checkoutUrl: null,
          expiresAt: persisted.expiresAt,
          status: "awaiting_payment",
        },
      };
    }

    const payload = await gateway.createCardPayment({
      organizationId: payer.organizationId,
      orderId: input.storeOrderId,
      paymentId: input.storeOrderId,
      amount: input.amount,
      dueDate: todayAsPixDueDate(),
      payer: { name: payer.name, email: payer.email, cpfCnpj: payer.cpf, phone: payer.phone || undefined },
      description,
      installments: 1,
      successUrl: `${appBaseUrl()}/minha-conta/compras/loja/${input.storeOrderId}`,
    });
    if (isProductionPaymentRuntime() && gateway.name !== "asaas") {
      await cancelOrphanStoreCharge(gateway, {
        organizationId: payer.organizationId,
        storeOrderId: input.storeOrderId,
        providerPaymentId: payload.providerPaymentId,
      });
      return { success: false, message: UNAVAILABLE };
    }
    const persisted = await persistStoreGatewayCharge({
      storeOrderId: input.storeOrderId,
      paymentMethod: "credit_card",
      pixCode: null,
      pixQrCode: null,
      gatewayPaymentId: payload.providerPaymentId,
      expiresAt: payload.expiresAt,
      checkoutUrl: payload.checkoutUrl,
      provider: gateway.name,
      accountKey,
      environment,
    });
    if (!persisted.success) {
      await cancelOrphanStoreCharge(gateway, {
        organizationId: payer.organizationId,
        storeOrderId: input.storeOrderId,
        providerPaymentId: payload.providerPaymentId,
      });
      return persisted;
    }
    return {
      success: true,
      payment: {
        storeOrderId: input.storeOrderId,
        orderNumber: input.orderNumber,
        finalAmount: input.amount,
        paymentMethod: "credit_card",
        pixCode: null,
        pixQrCode: null,
        checkoutUrl: persisted.checkoutUrl,
        expiresAt: persisted.expiresAt,
        status: "awaiting_payment",
      },
    };
  } catch (error) {
    console.error("[loja:checkout] gateway_create_failed", {
      store_order_id: input.storeOrderId,
      method: input.paymentMethod,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      message: isProductionPaymentRuntime() ? UNAVAILABLE : error instanceof Error ? error.message : UNAVAILABLE,
    };
  }
}

export async function createAccountStoreOrderAction(input: {
  eventId: string | null;
  items: StoreCartLine[];
  paymentMethod: "pix" | "credit_card";
}) {
  const supabase = await createServerSupabaseClient();
  await supabase.rpc("expire_expired_store_orders");
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false as const, message: "Entre na sua conta para continuar a compra." };
  if (!isEmailConfirmed(user)) {
    return { success: false as const, message: ACCOUNT_NOT_CONFIRMED_MESSAGE, code: "email_not_confirmed" };
  }

  try {
    assertStoreLiveGateway(input.paymentMethod);
  } catch (error) {
    return { success: false as const, message: error instanceof Error ? error.message : UNAVAILABLE };
  }

  const { data, error } = await supabase.rpc("create_store_order", {
    p_event_id: input.eventId,
    p_items: input.items.map((item) => ({
      store_item_id: item.storeItemId,
      variant_id: item.variantId,
      quantity: item.quantity,
    })),
    p_payment_method: input.paymentMethod,
  });
  if (error) return { success: false as const, message: error.message };
  const result = Array.isArray(data) ? data[0] : data;
  const storeOrderId = String(result?.store_order_id ?? "");
  const orderNumber = String(result?.order_number ?? "");
  const finalAmount = Number(result?.final_amount ?? 0);
  if (!storeOrderId) return { success: false as const, message: "Falha ao criar o pedido da Loja." };

  if (finalAmount <= 0) {
    await rollbackStoreOrder(storeOrderId);
    return { success: false as const, message: UNAVAILABLE };
  }

  const started = await startStoreGatewayPayment({
    storeOrderId,
    orderNumber,
    amount: finalAmount,
    paymentMethod: input.paymentMethod,
  });
  revalidatePath("/minha-conta/loja");
  revalidatePath("/minha-conta/compras");
  revalidatePath(`/minha-conta/compras/loja/${storeOrderId}`);

  if (!started.success) {
    return {
      success: false as const,
      message: started.message,
      storeOrderId,
      orderNumber,
      finalAmount,
    };
  }

  return {
    success: true as const,
    message: "Pedido criado.",
    storeOrderId,
    orderNumber,
    finalAmount,
    payment: started.payment,
  };
}

export async function generateStoreOrderPixAction(storeOrderId: string, amount: number) {
  return startAccountStoreOrderPaymentAction(storeOrderId, "pix", amount);
}

export async function startAccountStoreOrderPaymentAction(
  storeOrderId: string,
  paymentMethod: "pix" | "credit_card",
  amount?: number,
) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false as const, message: "Entre na sua conta para continuar." };
  const { data: order } = await supabase
    .from("store_orders")
    .select("id, order_number, final_amount")
    .eq("id", storeOrderId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!order) return { success: false as const, message: "Pedido não encontrado." };
  const started = await startStoreGatewayPayment({
    storeOrderId,
    orderNumber: String(order.order_number ?? ""),
    amount: Number(order.final_amount ?? amount ?? 0),
    paymentMethod,
  });
  if (!started.success) return started;
  revalidatePath("/minha-conta/loja");
  revalidatePath(`/minha-conta/compras/loja/${storeOrderId}`);
  return {
    success: true as const,
    message: "Pagamento atualizado.",
    pixCode: started.payment.pixCode ?? "",
    pixQrCode: started.payment.pixQrCode ?? "",
    expiresAt: started.payment.expiresAt,
    checkoutUrl: started.payment.checkoutUrl,
    payment: started.payment,
  };
}

export async function simulateStoreOrderPaymentAction(storeOrderId: string, method: "pix" | "credit_card") {
  if (isProductionPaymentRuntime() || getPaymentGatewayProviderName() === "asaas") {
    return { success: false as const, message: "A confirmação simulada não está disponível neste ambiente." };
  }
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const isLocalSupabase = /^https?:\/\/(127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(supabaseUrl);
  if (process.env.NODE_ENV !== "development" || !isLocalSupabase) {
    return { success: false as const, message: "A confirmacao simulada esta disponivel apenas no ambiente local." };
  }
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user?.id) return { success: false as const, message: "Entre na sua conta para continuar." };
  const { data: ownedOrder, error: ownershipError } = await supabase
    .from("store_orders")
    .select("id, provider, pix_code, pix_qrcode, gateway_payment_id")
    .eq("id", storeOrderId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (ownershipError || !ownedOrder?.id) {
    return { success: false as const, message: ownershipError?.message ?? "Pedido não encontrado." };
  }
  if (
    !isSyntheticGatewayPayload({
      provider: ownedOrder.provider,
      pixCode: ownedOrder.pix_code,
      pixQrCode: ownedOrder.pix_qrcode,
      gatewayPaymentId: ownedOrder.gateway_payment_id,
    })
  ) {
    return { success: false as const, message: "Pagamento real da Loja so confirma via webhook." };
  }

  const admin = createServiceRoleSupabaseClient();
  const { error } = await admin.rpc("simulate_store_order_payment", {
    p_store_order_id: storeOrderId,
    p_payment_method: method,
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/minha-conta/loja");
  return { success: true as const, message: "Pagamento confirmado (simulado)." };
}

export async function cancelAccountStoreOrderAction(storeOrderId: string) {
  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.rpc("cancel_store_order", {
    p_store_order_id: storeOrderId,
    p_reason: "Cancelado pelo participante",
  });
  if (error) return { success: false as const, message: error.message };
  revalidatePath("/minha-conta/loja");
  return { success: true as const, message: "Pedido cancelado." };
}
