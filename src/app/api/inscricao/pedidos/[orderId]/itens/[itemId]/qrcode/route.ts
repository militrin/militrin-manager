import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { hasPermission } from "@/lib/admin/permissions";
import { generateQrPngBase64 } from "@/lib/qr/generate-qr-data-url";
import { orderDisplayReference } from "@/lib/display-reference";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function one<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// QR por ITEM de produto "compre junto" (order_items.item_kind='product',
// dentro do MESMO pedido do ingresso -- dominio DIFERENTE de store_orders/
// store_order_items, que ja tem sua propria rota em
// /api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode). Mesma composicao
// visual (SVG + QR local) e a MESMA regra de autorizacao ja
// confirmada para a rota da loja: dono do pedido OU store.deliver OU
// store.manage. Conteudo do QR e order_items.qr_token (20260916000000),
// nunca order_number.
//
// Le com o client de service role (nao o client de sessao): RLS de
// orders/order_items so libera SELECT pro dono OU pra quem tem uma das
// permissoes de pedido/financeiro (orders.view/finance.*/participants.view)
// -- nao inclui store.deliver/store.manage, entao um operador de entrega
// sem nenhuma dessas outras permissoes ficaria bloqueado pelo RLS antes
// mesmo de chegar na checagem explicita abaixo. A autorizacao real desta
// rota e 100% o `if` explicito logo apos a consulta -- nunca a RLS.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string; itemId: string }> },
) {
  const { orderId, itemId } = await params;
  if (!isUuid(orderId) || !isUuid(itemId)) return new NextResponse("Item inválido", { status: 404 });

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const [canDeliver, canManage] = await Promise.all([hasPermission("store.deliver"), hasPermission("store.manage")]);

  const adminClient = createServiceRoleSupabaseClient();
  const { data: item, error } = await adminClient
    .from("order_items")
    .select(
      "id, quantity, qr_token, pickup_qr_mode, item_kind, order_id, store_items(name), store_item_variants(name, value), orders!inner(id, user_id, order_number, display_number, events(name))",
    )
    .eq("id", itemId)
    .eq("order_id", orderId)
    .eq("item_kind", "product")
    .maybeSingle();
  if (error || !item?.qr_token) return new NextResponse("Item não encontrado", { status: 404 });
  if (item.pickup_qr_mode === "none") return new NextResponse("Este item não usa QR de retirada", { status: 404 });
  if (item.pickup_qr_mode === "per_unit" && Number(item.quantity ?? 1) > 1) {
    return new NextResponse("Este item usa QR por unidade — use a rota de QR da unidade", { status: 404 });
  }

  const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
  const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
  const order = one(item.orders as Record<string, unknown> | Record<string, unknown>[] | null);
  if (order?.user_id !== user.id && !canDeliver && !canManage) {
    return new NextResponse("Sem permissão para gerar este QR", { status: 403 });
  }
  const eventObj = one(order?.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventName = eventObj?.name ? String(eventObj.name) : "";
  const itemName = storeItem?.name ? String(storeItem.name) : "Item";
  const variantText = variant ? ` — ${String(variant.name)}: ${String(variant.value)}` : "";
  const orderNumber = orderDisplayReference(order?.display_number, order?.order_number);

  let qrBase64: string;
  try {
    qrBase64 = await generateQrPngBase64(String(item.qr_token), 512);
  } catch {
    return new NextResponse("Não foi possível gerar o QR Code", { status: 500 });
  }

  const width = 560;
  const qrSize = 320;
  const padding = 32;
  const headerHeight = eventName ? 96 : 68;
  const qrBottom = headerHeight + qrSize;
  const height = qrBottom + 96;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="${width / 2}" y="${padding + 24}" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#0f172a">${escapeXml(`${item.quantity}x ${itemName}${variantText}`)}</text>
    ${eventName ? `<text x="${width / 2}" y="${padding + 50}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#475569">${escapeXml(eventName)}</text>` : ""}
    <image x="${(width - qrSize) / 2}" y="${headerHeight}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrBase64}" />
    <text x="${width / 2}" y="${qrBottom + 32}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#64748b">Pedido ${escapeXml(orderNumber)}</text>
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Disposition": new URL(request.url).searchParams.get("inline") === "1"
        ? "inline"
        : `attachment; filename="item-pedido-${orderNumber.replace('#', '')}.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}
