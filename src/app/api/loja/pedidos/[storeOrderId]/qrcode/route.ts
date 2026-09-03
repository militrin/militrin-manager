import { NextResponse } from "next/server";
import { createServerSupabaseClient } from "@/lib/supabase/server";
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

export async function GET(request: Request, { params }: { params: Promise<{ storeOrderId: string }> }) {
  const { storeOrderId } = await params;
  if (!isUuid(storeOrderId)) return new NextResponse("Pedido inválido", { status: 404 });

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new NextResponse("Sessão expirada", { status: 401 });

  const { data: order, error } = await supabase
    .from("store_orders")
    .select(
      "id, order_number, display_number, status, events(name), store_order_items(quantity, store_items(name), store_item_variants(name, value))"
    )
    .eq("id", storeOrderId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !order) return new NextResponse("Pedido não encontrado", { status: 404 });
  if (order.status !== "confirmed") return new NextResponse("Pedido ainda não confirmado", { status: 409 });

  const eventObj = one(order.events as Record<string, unknown> | Record<string, unknown>[] | null);
  const eventName = eventObj?.name ? String(eventObj.name) : "";
  const items = Array.isArray(order.store_order_items) ? (order.store_order_items as Array<Record<string, unknown>>) : [];
  const itemLines = items.map((item) => {
    const storeItem = one(item.store_items as Record<string, unknown> | Record<string, unknown>[] | null);
    const variant = one(item.store_item_variants as Record<string, unknown> | Record<string, unknown>[] | null);
    const name = storeItem?.name ? String(storeItem.name) : "Item";
    const variantText = variant ? ` — ${variant.name}: ${variant.value}` : "";
    return `${String(item.quantity)}x ${name}${variantText}`;
  });
  const orderReference = orderDisplayReference(order.display_number, order.order_number);

  let qrBase64: string;
  try {
    qrBase64 = await generateQrPngBase64(String(order.order_number), 512);
  } catch {
    return new NextResponse("Não foi possível gerar o QR Code", { status: 500 });
  }

  const width = 640;
  const qrSize = 320;
  const padding = 32;
  const lineHeight = 28;
  const headerHeight = eventName ? 96 : 68;
  const qrBottom = headerHeight + qrSize;
  const labelY = qrBottom + 32;
  const listStartY = labelY + 30;
  const height = listStartY + Math.max(itemLines.length - 1, 0) * lineHeight + padding;

  const itemLinesSvg = itemLines
    .map(
      (line, index) =>
        `<text x="${width / 2}" y="${listStartY + index * lineHeight}" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" fill="#0f172a">${escapeXml(line)}</text>`
    )
    .join("\n    ");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#ffffff" />
    <text x="${width / 2}" y="${padding + 24}" text-anchor="middle" font-family="Arial, sans-serif" font-size="22" font-weight="bold" fill="#0f172a">Pedido ${escapeXml(orderReference)}</text>
    ${eventName ? `<text x="${width / 2}" y="${padding + 52}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" fill="#475569">${escapeXml(eventName)}</text>` : ""}
    <image x="${(width - qrSize) / 2}" y="${headerHeight}" width="${qrSize}" height="${qrSize}" href="data:image/png;base64,${qrBase64}" />
    <text x="${width / 2}" y="${labelY}" text-anchor="middle" font-family="Arial, sans-serif" font-size="14" fill="#64748b">Itens a retirar</text>
    ${itemLinesSvg}
  </svg>`;

  return new NextResponse(svg, {
    headers: {
      "Content-Type": "image/svg+xml",
      "Content-Disposition": `attachment; filename="pedido-${orderReference.replace('#', '')}.svg"`,
      "Cache-Control": "private, no-store",
    },
  });
}
