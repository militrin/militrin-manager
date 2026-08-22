import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { hasPermission } from "@/lib/admin/permissions";

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

// QR por ITEM de pedido de loja (nao por pedido inteiro) -- usado pra
// impressao antes do evento e leitura pelo Modo Turbo (Fluxo B). Reaproveita
// a mesma composicao visual (SVG + QR embutido via api.qrserver.com) da rota
// de QR por pedido em /api/loja/pedidos/[storeOrderId]/qrcode; aqui o
// conteudo do QR e store_order_items.qr_token (migration 20260860000000),
// nao mais order_number, porque o Turbo precisa resolver um item individual
// sem abrir o pedido inteiro.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ storeOrderId: string; itemId: string }> },
) {
  const { storeOrderId, itemId } = await params;
  if (!isUuid(storeOrderId) || !isUuid(itemId)) return new NextResponse("Item inválido", { status: 404 });

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const [canDeliver, canManage] = await Promise.all([hasPermission("store.deliver"), hasPermission("store.manage")]);
  if (!canDeliver && !canManage) return new NextResponse("Sem permissão para gerar este QR", { status: 403 });

  const { data: item, error } = await supabase
    .from("store_order_items")
    .select(
      "id, quantity, qr_token, store_order_id, store_items(name), store_item_variants(name, value), store_orders!inner(id, order_number, events(name))",
    )
    .eq("id", itemId)
    .eq("store_order_id", storeOrderId)
    .maybeSingle();
  if (error || !item?.qr_token) return new NextResponse("Item não encontrado", { status: 404 });

  const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
  const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
  const order = one(item.store_orders as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventObj = one(order?.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventName = eventObj?.name ? String(eventObj.name) : "";
  const itemName = storeItem?.name ? String(storeItem.name) : "Item";
  const variantText = variant ? ` — ${String(variant.name)}: ${String(variant.value)}` : "";
  const orderNumber = order?.order_number ? String(order.order_number) : "";

  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=512x512&data=${encodeURIComponent(String(item.qr_token))}`;
  const upstream = await fetch(qrUrl);
  if (!upstream.ok) return new NextResponse("Não foi possível gerar o QR Code", { status: 502 });
  const qrBase64 = Buffer.from(await upstream.arrayBuffer()).toString("base64");

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
      "Content-Disposition": `attachment; filename="item-${item.qr_token}.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}
