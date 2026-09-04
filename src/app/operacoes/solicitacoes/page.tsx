import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { AdminPageHeader } from "@/components/admin";
import { ticketDisplayReference } from "@/lib/display-reference";
import { SolicitacoesClient, type PendingChangeRequestRow } from "./SolicitacoesClient";

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}

// Rotulo tolerante: requested_variant sempre tem {id,name,value} (gravado
// assim por request_ticket_item_change), mas current_variant e uma copia de
// participant_kit_items.variant_data, que tem 2 formatos possiveis
// dependendo de qual RPC escreveu por ultimo -- admin_change_ticket_shirt
// grava {shirt_type,shirt_size,...} e review_ticket_item_change_request
// (apos uma aprovacao anterior) grava {variant_name,variant_value,...}. Ver
// o mesmo fallback em minha-conta/ingressos/[ticketId]/itens/page.tsx.
function formatVariantLabel(variant: Record<string, unknown> | null | undefined): string {
  if (!variant) return "—";
  const type = variant.name ?? variant.variant_name ?? variant.shirt_type;
  const size = variant.value ?? variant.variant_value ?? variant.shirt_size;
  if (type && size) return `${String(type)} ${String(size)}`;
  return String(type ?? size ?? "—");
}

export default async function OperacoesSolicitacoesPage() {
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) {
    return (
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <div className="flex flex-1 flex-col p-6">Selecione uma organização para ver as solicitações.</div>
      </div>
    );
  }

  const supabase = await createServerSupabaseClient();

  const { data: requestsRaw, error: requestsError } = await supabase
    .from("ticket_item_change_requests")
    .select(
      "id, ticket_id, kit_item_id, requested_variant_id, current_variant, requested_variant, requested_at, reason, event_id, events(name), event_kit_items(name,item_type,shirt_supply_mode,track_variant_inventory), tickets(order_items(item_position, holder_full_name, registration_contact_id, registration_contacts!order_items_registration_contact_id_fkey(full_name)), orders(display_number, order_number))",
    )
    .eq("organization_id", organization.id)
    .eq("status", "pending")
    .order("requested_at", { ascending: false });

  if (requestsError) {
    return (
      <div className="flex min-h-screen bg-slate-950 text-slate-100">
        <Sidebar />
        <div className="flex flex-1 flex-col p-6">Não foi possível carregar as solicitações agora.</div>
      </div>
    );
  }

  const rows = (requestsRaw ?? []) as Array<Record<string, unknown>>;

  // Estoque atual (para a caixa "Estoque atual de X: N unidades" no detalhe)
  // buscado em lote, nao 1 query por linha -- a mesma tabela canonica
  // (event_kit_item_variant_inventory) usada por admin_change_ticket_shirt.
  const variantIds = Array.from(new Set(rows.map((row) => String(row.requested_variant_id ?? "")).filter(Boolean)));
  const inventoryByVariantId = new Map<string, { total: number; reserved: number; delivered: number }>();
  if (variantIds.length > 0) {
    const { data: inventoryRows } = await supabase
      .from("event_kit_item_variant_inventory")
      .select("variant_id,total_quantity,reserved_quantity,delivered_quantity")
      .in("variant_id", variantIds);
    for (const inv of inventoryRows ?? []) {
      inventoryByVariantId.set(String(inv.variant_id), {
        total: Number(inv.total_quantity ?? 0),
        reserved: Number(inv.reserved_quantity ?? 0),
        delivered: Number(inv.delivered_quantity ?? 0),
      });
    }
  }

  const pendingRequests: PendingChangeRequestRow[] = rows.map((row) => {
    const kitItem = firstRelation(row.event_kit_items as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const event = firstRelation(row.events as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const ticket = firstRelation(row.tickets as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const orderItem = firstRelation(ticket?.order_items as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const order = firstRelation(ticket?.orders as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const registrationContact = firstRelation(orderItem?.registration_contacts as Record<string, unknown> | Record<string, unknown>[] | null | undefined);
    const holderName = String(registrationContact?.full_name ?? orderItem?.holder_full_name ?? "Titular não identificado");
    const ticketReference = ticketDisplayReference(order?.display_number, orderItem?.item_position, order?.order_number);

    const itemType = String(kitItem?.item_type ?? "");
    const tracked = itemType === "shirt" ? kitItem?.shirt_supply_mode === "stock" : Boolean(kitItem?.track_variant_inventory);
    const inv = inventoryByVariantId.get(String(row.requested_variant_id ?? ""));
    const available = tracked && inv ? Math.max(inv.total - inv.reserved - inv.delivered, 0) : null;

    return {
      id: String(row.id),
      ticketId: String(row.ticket_id),
      ticketReference,
      eventId: String(row.event_id ?? ""),
      eventName: String(event?.name ?? "Evento"),
      kitItemName: String(kitItem?.name ?? "Item"),
      holderName,
      currentLabel: formatVariantLabel(row.current_variant as Record<string, unknown> | null),
      requestedLabel: formatVariantLabel(row.requested_variant as Record<string, unknown> | null),
      requestedVariantId: String(row.requested_variant_id ?? ""),
      requestedAt: String(row.requested_at ?? ""),
      reason: row.reason ? String(row.reason) : null,
      stock: { tracked, available },
    };
  });

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-100">
      <Sidebar />
      <div className="flex flex-1 flex-col">
        <main className="mx-auto w-full max-w-5xl space-y-6 px-4 py-6 sm:px-6">
          <AdminPageHeader
            title="Solicitações de alteração"
            subtitle="Fila de alterações de item de kit (ex.: tamanho de camiseta) pedidas pelo participante na Minha Conta, aguardando aprovação do organizador."
          />
          <SolicitacoesClient initialRequests={pendingRequests} />
        </main>
      </div>
    </div>
  );
}
