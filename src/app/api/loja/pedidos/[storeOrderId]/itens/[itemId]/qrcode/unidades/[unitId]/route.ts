import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/admin/permissions";
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

// QR por UNIDADE individual (store_order_item_pickup_units, pickup_qr_mode=
// 'per_unit', quantity>1) -- espelha byte a byte a rota de item existente
// (/api/loja/pedidos/[storeOrderId]/itens/[itemId]/qrcode), so trocando a
// fonte do token e o texto do cabecalho pra "Unidade X de N" em vez de
// "NxItem". Mesma autorizacao: dono do pedido OU store.deliver OU
// store.manage.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ storeOrderId: string; itemId: string; unitId: string }> },
) {
  const { storeOrderId, itemId, unitId } = await params;
  if (!isUuid(storeOrderId) || !isUuid(itemId) || !isUuid(unitId)) return new NextResponse("Item inválido", { status: 404 });

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const [canDeliver, canManage] = await Promise.all([hasPermission("store.deliver"), hasPermission("store.manage")]);

  const { data: unit, error } = await supabase
    .from("store_order_item_pickup_units")
    .select(
      "id, unit_index, qr_token, store_order_item_id, store_order_items!inner(id, quantity, store_order_id, store_items(name), store_item_variants(name, value), store_orders!inner(id, user_id, order_number, display_number, events(name)))",
    )
    .eq("id", unitId)
    .eq("store_order_item_id", itemId)
    .maybeSingle();
  if (error || !unit?.qr_token) return new NextResponse("Unidade não encontrada", { status: 404 });

  const line = one(unit.store_order_items as Record<string, unknown> | Record<string, unknown>[] | null);
  if (!line || String(line.store_order_id) !== storeOrderId) return new NextResponse("Unidade não encontrada", { status: 404 });

  const storeItem = one(line.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
  const variant = one(line.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
  const order = one(line.store_orders as Record<string, unknown> | Record<string, unknown>[] | null);
  if (order?.user_id !== user.id && !canDeliver && !canManage) {
    return new NextResponse("Sem permissão para gerar este QR", { status: 403 });
  }
  const eventObj = one(order?.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventName = eventObj?.name ? String(eventObj.name) : "";
  const itemName = storeItem?.name ? String(storeItem.name) : "Item";
  const variantText = variant ? ` — ${String(variant.name)}: ${String(variant.value)}` : "";
  const orderNumber = orderDisplayReference(order?.display_number, order?.order_number);
  const unitLabel = `Unidade ${unit.unit_index} de ${line.quantity}`;

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(String(unit.qr_token))}`;
  const upstream = await fetch(qrUrl);
  if (!upstream.ok) return new NextResponse("Não foi possível gerar o QR Code", { status: 502 });
  const qrBase64 = Buffer.from(await upstream.arrayBuffer()).toString("base64");

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
