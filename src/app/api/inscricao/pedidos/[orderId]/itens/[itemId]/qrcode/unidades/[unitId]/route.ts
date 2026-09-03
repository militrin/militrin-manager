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

// QR por UNIDADE individual do dominio "compre junto" (order_item_pickup_
// units) -- mesmo racional/estrutura da rota irma de loja standalone
// (.../loja/[storeOrderId]/itens/[itemId]/qrcode/unidades/[unitId]). Le com
// service role pelo mesmo motivo ja documentado na rota de item deste
// dominio: RLS de orders/order_items nao cobre store.deliver/store.manage.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ orderId: string; itemId: string; unitId: string }> },
) {
  const { orderId, itemId, unitId } = await params;
  if (!isUuid(orderId) || !isUuid(itemId) || !isUuid(unitId)) return new NextResponse("Item inválido", { status: 404 });

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const [canDeliver, canManage] = await Promise.all([hasPermission("store.deliver"), hasPermission("store.manage")]);

  const adminClient = createServiceRoleSupabaseClient();
  const { data: unit, error } = await adminClient
    .from("order_item_pickup_units")
    .select(
      "id, unit_index, qr_token, order_item_id, order_items!inner(id, quantity, order_id, item_kind, store_items(name), store_item_variants(name, value), orders!inner(id, user_id, order_number, display_number, events(name)))",
    )
    .eq("id", unitId)
    .eq("order_item_id", itemId)
    .maybeSingle();
  if (error || !unit?.qr_token) return new NextResponse("Unidade não encontrada", { status: 404 });

  const line = one(unit.order_items as Record<string, unknown> | Record<string, unknown>[] | null);
  if (!line || String(line.order_id) !== orderId || line.item_kind !== "product") {
    return new NextResponse("Unidade não encontrada", { status: 404 });
  }

  const storeItem = one(line.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
  const variant = one(line.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
  const order = one(line.orders as Record<string, unknown> | Record<string, unknown>[] | null);
  if (order?.user_id !== user.id && !canDeliver && !canManage) {
    return new NextResponse("Sem permissão para gerar este QR", { status: 403 });
  }
  const eventObj = one(order?.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventName = eventObj?.name ? String(eventObj.name) : "";
  const itemName = storeItem?.name ? String(storeItem.name) : "Item";
  const variantText = variant ? ` — ${String(variant.name)}: ${String(variant.value)}` : "";
  const orderNumber = orderDisplayReference(order?.display_number, order?.order_number);
  const unitLabel = `Unidade ${unit.unit_index} de ${line.quantity}`;

  let qrBase64: string;
  try {
    qrBase64 = await generateQrPngBase64(String(unit.qr_token), 512);
  } catch {
    return new NextResponse("Não foi possível gerar o QR Code", { status: 500 });
  }

  const width = 560;
  const qrSize = 320;
  const padding = 32;
  const headerHeight = eventName ? 118 : 90;
  const qrBottom = headerHeight + qrSize;
  const height = qrBottom + 96;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="${width / 2}" y="${padding + 24}" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#0f172a">${escapeXml(`${itemName}${variantText}`)}</text>
    <text x="${width / 2}" y="${padding + 48}" text-anchor="middle" font-family="Arial, sans-serif" font-size="15" font-weight="bold" fill="#0891b2">${escapeXml(unitLabel)}</text>
    ${eventName ? `<text x="${width / 2}" y="${padding + 72}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#475569">${escapeXml(eventName)}</text>` : ""}
    <image x="${(width - qrSize) / 2}" y="${headerHeight}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrBase64}" />
    <text x="${width / 2}" y="${qrBottom + 32}" text-anchor="middle" font-family="Arial, sans-serif" font-size="13" fill="#64748b">Pedido ${escapeXml(orderNumber)}</text>
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Disposition": new URL(request.url).searchParams.get("inline") === "1"
        ? "inline"
        : `attachment; filename="unidade-${unit.unit_index}-pedido-${orderNumber.replace('#', '')}.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}
