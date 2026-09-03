"use client";

import { useEffect, useState } from "react";
import { useTransition } from "react";
import { getEventKitItemsForLinkAction, upsertStoreItemAction } from "./actions";

type EventOption = { id: string; name: string; year: number | null; is_active: boolean };

type StoreItemInput = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price: number;
  discountType: "percentage" | "fixed" | null;
  discountValue: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  availableAllEvents: boolean;
  visibility: "public" | "code_required" | "admin_only";
  isActive: boolean;
  eventId: string | null;
  linkedEventKitItemId: string | null;
  pickupQrMode: "per_unit" | "per_line" | "none";
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function computeFinalPrice(price: number, discountType: "percentage" | "fixed" | null, discountValue: number) {
  if (discountType === "percentage") return Math.max(price * (1 - Math.min(discountValue, 100) / 100), 0);
  if (discountType === "fixed") return Math.max(price - discountValue, 0);
  return price;
}

type LinkKitItem = { id: string; name: string; itemType: string; requiresVariant: boolean; variants: Array<{ id: string; name: string; value: string }> };

function slugify(value: string) {
  const base = value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "item";
}

function eventLabelFor(events: EventOption[], eventId: string) {
  const event = events.find((e) => e.id === eventId);
  return event ? `${event.name}${event.year ? ` ${event.year}` : ""}` : "Evento";
}

const fieldLabelClass = "mb-1 block text-xs font-medium text-slate-400";

export function StoreItemForm({
  events,
  eventId,
  eventLabel,
  item,
}: {
  events: EventOption[];
  // Evento de contexto (filtro atual da pagina). null quando o filtro esta
  // em "Todos os eventos" -- nesse caso o item criado e global.
  eventId: string | null;
  eventLabel: string;
  item: StoreItemInput | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState(item?.name ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [price, setPrice] = useState(String(item?.price ?? "0"));
  const [discountType, setDiscountType] = useState<"percentage" | "fixed" | null>(item?.discountType ?? null);
  const [discountValue, setDiscountValue] = useState(String(item?.discountValue ?? "0"));
  const [requiresVariant, setRequiresVariant] = useState(item?.requiresVariant ?? false);
  const [supplyMode, setSupplyMode] = useState<"stock" | "made_to_order">(item?.supplyMode ?? "stock");
  const [availableAllEvents, setAvailableAllEvents] = useState(item?.availableAllEvents ?? false);
  const [visibility, setVisibility] = useState<"public" | "code_required" | "admin_only">(item?.visibility ?? "public");
  const [pickupQrMode, setPickupQrMode] = useState<"per_unit" | "per_line" | "none">(item?.pickupQrMode ?? "per_line");
  const [message, setMessage] = useState<string | null>(null);

  // Tipo de estoque: item independente da loja, ou vinculado ao mesmo
  // estoque de um item de kit de um evento (ex.: a camiseta oficial do
  // kit). Editando um item ja vinculado, o evento de referencia e o
  // PROPRIO evento do item (nao o filtro da pagina).
  const [stockType, setStockType] = useState<"own" | "event_kit">(item?.linkedEventKitItemId ? "event_kit" : "own");
  const [linkEventId, setLinkEventId] = useState(item?.eventId ?? eventId ?? "");
  const [linkKitItemId, setLinkKitItemId] = useState(item?.linkedEventKitItemId ?? "");
  const [kitItemsForLink, setKitItemsForLink] = useState<LinkKitItem[]>([]);
  const [loadingKitItems, setLoadingKitItems] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (stockType !== "event_kit" || !linkEventId) {
        if (!cancelled) setKitItemsForLink([]);
        return;
      }
      setLoadingKitItems(true);
      const result = await getEventKitItemsForLinkAction(linkEventId);
      if (cancelled) return;
      setKitItemsForLink(result.success ? (result.items as LinkKitItem[]).filter((kitItem) => kitItem.requiresVariant) : []);
      setLoadingKitItems(false);
    })();
    return () => { cancelled = true; };
  }, [stockType, linkEventId]);

  const selectedKitItem = kitItemsForLink.find((kitItem) => kitItem.id === linkKitItemId) ?? null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200"
      >
        {item ? "Editar produto" : "Novo item"}
      </button>
    );
  }

  return (
    <form
      className="grid gap-3 rounded-xl border border-slate-700 bg-slate-950/60 p-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (stockType === "event_kit" && (!linkEventId || !linkKitItemId)) {
          setMessage("Selecione o evento e o item de kit para vincular.");
          return;
        }
        const priceValue = Number(price) || 0;
        const discountValueNumber = Number(discountValue) || 0;
        if (discountType === "percentage" && (discountValueNumber < 0 || discountValueNumber > 100)) {
          setMessage("Desconto percentual deve estar entre 0 e 100.");
          return;
        }
        if (discountType === "fixed" && (discountValueNumber < 0 || discountValueNumber > priceValue)) {
          setMessage("Desconto em R$ não pode ser negativo nem maior que o valor do produto.");
          return;
        }
        startTransition(async () => {
          const result = await upsertStoreItemAction({
            id: item?.id ?? null,
            eventId: stockType === "event_kit" ? linkEventId : eventId,
            name,
            slug: `${slugify(name)}-${(item?.id ?? crypto.randomUUID()).slice(0, 8)}`,
            description,
            price: priceValue,
            discountType,
            discountValue: discountType ? discountValueNumber : 0,
            requiresVariant: stockType === "event_kit" ? true : requiresVariant,
            // Preserva o estado atual de ativo/desativado -- este formulario
            // nunca reativa/desativa por conta propria (isso e acao
            // dedicada, "Desativar"/"Reativar", auditada separadamente).
            isActive: item?.isActive ?? true,
            sortOrder: item?.sortOrder ?? 0,
            supplyMode,
            availableAllEvents: stockType === "event_kit" ? false : availableAllEvents,
            visibility,
            linkedEventKitItemId: stockType === "event_kit" ? linkKitItemId : null,
            pickupQrMode,
          });
          setMessage(result.message);
          if (result.success && !item) {
            setName(""); setDescription(""); setPrice("0"); setDiscountType(null); setDiscountValue("0"); setRequiresVariant(false); setSupplyMode("stock");
            setAvailableAllEvents(false); setVisibility("public"); setStockType("own"); setLinkKitItemId(""); setPickupQrMode("per_line"); setOpen(false);
          }
        });
      }}
    >
      {!item ? (
        <p className="text-xs text-slate-500 sm:col-span-2">As fotos são adicionadas depois, na lista de itens, assim que este item for salvo.</p>
      ) : null}
      <div>
        <label className={fieldLabelClass} htmlFor="store-item-name">Nome do item</label>
        <input
          id="store-item-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex.: Squeeze Militrin"
          required
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        />
      </div>
      <div>
        <label className={fieldLabelClass} htmlFor="store-item-price">Preço (R$)</label>
        <input
          id="store-item-price"
          value={price}
          onChange={(e) => setPrice(e.target.value)}
          type="number" min="0" step="0.01"
          required
          className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
        />
      </div>
      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Desconto (opcional)</span>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={discountType ?? ""}
            onChange={(e) => {
              const value = e.target.value;
              setDiscountType(value === "percentage" || value === "fixed" ? value : null);
              if (!value) setDiscountValue("0");
            }}
            className="h-9 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
          >
            <option value="">Sem desconto</option>
            <option value="percentage">Percentual (%)</option>
            <option value="fixed">Valor fixo (R$)</option>
          </select>
          {discountType ? (
            <input
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              type="number" min="0" max={discountType === "percentage" ? 100 : undefined} step="0.01"
              className="h-9 w-28 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
            />
          ) : null}
        </div>
        {discountType ? (
          <p className="mt-1 text-xs text-slate-400">
            Preço final: <span className="text-slate-500 line-through">{money(Number(price) || 0)}</span>{" "}
            <span className="font-semibold text-emerald-300">{money(computeFinalPrice(Number(price) || 0, discountType, Number(discountValue) || 0))}</span>
          </p>
        ) : null}
      </div>
      <div className="sm:col-span-2">
        <label className={fieldLabelClass} htmlFor="store-item-description">Descrição (opcional)</label>
        <textarea
          id="store-item-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="O que é, como funciona, o que vem incluso..."
          className="h-16 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
        />
      </div>

      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Tipo de estoque</span>
        <div className="flex flex-col gap-1.5 text-xs text-slate-300">
          <label className="flex items-center gap-2">
            <input type="radio" checked={stockType === "own"} onChange={() => setStockType("own")} />
            Estoque próprio
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={stockType === "event_kit"} onChange={() => setStockType("event_kit")} />
            Usar camiseta (ou outro item) de um evento
          </label>
        </div>
      </div>

      {stockType === "event_kit" ? (
        <div className="space-y-3 rounded-xl border border-sky-500/30 bg-sky-500/5 p-3 sm:col-span-2">
          <p className="text-xs text-sky-200">Este produto utilizará os mesmos tamanhos e o mesmo estoque do item de kit escolhido — nenhum estoque separado é criado na loja.</p>
          <label className="block space-y-1">
            <span className={fieldLabelClass}>Evento</span>
            <select
              value={linkEventId}
              onChange={(e) => { setLinkEventId(e.target.value); setLinkKitItemId(""); }}
              className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100"
            >
              <option value="">Selecione</option>
              {events.map((event) => (
                <option key={event.id} value={event.id}>{eventLabelFor(events, event.id)}</option>
              ))}
            </select>
          </label>
          <label className="block space-y-1">
            <span className={fieldLabelClass}>Item</span>
            <select
              value={linkKitItemId}
              onChange={(e) => setLinkKitItemId(e.target.value)}
              disabled={!linkEventId || loadingKitItems}
              className="h-9 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 disabled:opacity-50"
            >
              <option value="">{loadingKitItems ? "Carregando..." : "Selecione"}</option>
              {kitItemsForLink.map((kitItem) => (
                <option key={kitItem.id} value={kitItem.id}>{kitItem.name}</option>
              ))}
            </select>
          </label>
          {selectedKitItem ? (
            <div className="rounded-lg border border-slate-800 bg-slate-950/60 p-2 text-xs text-slate-400">
              <p className="mb-1 font-medium text-slate-300">Tamanhos deste item (somente leitura aqui — gerencie pelo evento):</p>
              {selectedKitItem.variants.length === 0 ? (
                <p>Nenhum tamanho cadastrado neste item ainda.</p>
              ) : (
                <ul className="space-y-0.5">
                  {selectedKitItem.variants.map((variant) => (
                    <li key={variant.id}>{variant.name} {variant.value}</li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2 text-xs text-slate-300 sm:col-span-2">
            <input type="checkbox" checked={requiresVariant} onChange={(e) => setRequiresVariant(e.target.checked)} />
            Este item tem opções (ex.: tamanho, cor) que o comprador precisa escolher
          </label>
          <div className="sm:col-span-2">
            <span className={fieldLabelClass}>Disponibilidade de estoque</span>
            <div className="flex flex-col gap-1.5 text-xs text-slate-300">
              <label className="flex items-center gap-2">
                <input type="radio" checked={supplyMode === "stock"} onChange={() => setSupplyMode("stock")} />
                Estoque limitado — eu informo a quantidade disponível
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={supplyMode === "made_to_order"} onChange={() => setSupplyMode("made_to_order")} />
                Por encomenda — sem limite, produzido depois da compra
              </label>
            </div>
          </div>
          <div className="sm:col-span-2">
            <span className={fieldLabelClass}>Oferecer em quais eventos</span>
            <div className="flex flex-col gap-1.5 text-xs text-slate-300">
              <label className="flex items-center gap-2">
                <input type="radio" disabled={!eventId} checked={!availableAllEvents} onChange={() => setAvailableAllEvents(false)} />
                {eventId ? `Somente em ${eventLabel}` : "Somente em um evento específico (selecione um evento no filtro da página primeiro)"}
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={availableAllEvents || !eventId} onChange={() => setAvailableAllEvents(true)} />
                Em todos os eventos da organização
              </label>
            </div>
          </div>
        </>
      )}

      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>Visibilidade do produto</span>
        <div className="flex flex-col gap-1.5 text-xs text-slate-300">
          <label className="flex items-start gap-2">
            <input type="radio" checked={visibility === "public"} onChange={() => setVisibility("public")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">Público</span>
              <span className="block text-slate-500">Aparece normalmente na loja. Qualquer usuário elegível pode comprar.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={visibility === "code_required"} onChange={() => setVisibility("code_required")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">Somente com código</span>
              <span className="block text-slate-500">Não aparece na loja pública. O usuário precisa informar um código válido para liberar a compra. (Liberação por código ainda não implementada — hoje se comporta como somente administrativo.)</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={visibility === "admin_only"} onChange={() => setVisibility("admin_only")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">Somente administrativo</span>
              <span className="block text-slate-500">Não aparece para compra pública. Só um administrador pode conceder este item para um participante.</span>
            </span>
          </label>
        </div>
      </div>

      <div className="sm:col-span-2">
        <span className={fieldLabelClass}>QR de retirada</span>
        <div className="flex flex-col gap-1.5 text-xs text-slate-300">
          <label className="flex items-start gap-2">
            <input type="radio" checked={pickupQrMode === "per_unit"} onChange={() => setPickupQrMode("per_unit")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">QR por unidade</span>
              <span className="block text-slate-500">Comprando mais de 1, cada unidade ganha seu próprio QR — controle e retirada individual.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={pickupQrMode === "per_line"} onChange={() => setPickupQrMode("per_line")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">QR por compra/linha</span>
              <span className="block text-slate-500">1 QR cobre toda a quantidade comprada de uma vez. Comportamento padrão.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={pickupQrMode === "none"} onChange={() => setPickupQrMode("none")} className="mt-0.5" />
            <span>
              <span className="block font-medium text-slate-200">Sem QR de retirada</span>
              <span className="block text-slate-500">Não gera QR nenhum. Entrega confirmada manualmente em Loja → Pedidos.</span>
            </span>
          </label>
        </div>
        <p className="mt-1.5 text-[11px] text-slate-500">Mudar este modo não altera pedidos já feitos — vale só para novas compras a partir de agora.</p>
      </div>

      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className="inline-flex h-9 items-center rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 text-xs text-emerald-200 disabled:opacity-50">
          {pending ? "Salvando..." : "Salvar item"}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="inline-flex h-9 items-center rounded-lg border border-slate-700 px-3 text-xs text-slate-300">
          Cancelar
        </button>
        {message ? <span className="text-xs text-slate-400" role="status">{message}</span> : null}
      </div>
    </form>
  );
}
