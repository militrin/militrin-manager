import { StoreItemForm } from "./store-item-form";
import { StoreItemImageGallery } from "./store-item-image-gallery";
import { StoreItemVariantForm } from "./store-item-variant-form";
import { StoreStockInput } from "./store-stock-input";

type StoreItemVariant = {
  id: string;
  name: string;
  value: string;
  priceAdjustment: number;
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
};

type StoreItemImage = { id: string; url: string; isPrimary: boolean };

type StoreItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  primaryImageUrl: string | null;
  images: StoreItemImage[];
  price: number;
  requiresVariant: boolean;
  sortOrder: number;
  supplyMode: "stock" | "made_to_order";
  eventId: string | null;
  eventLabel: string;
  variants: StoreItemVariant[];
  totalQuantity: number;
  reservedQuantity: number;
  deliveredQuantity: number;
  availableQuantity: number;
};

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

export function StoreItemCard({
  contextEventId,
  contextEventLabel,
  item,
  canManage,
}: {
  contextEventId: string | null;
  contextEventLabel: string | null;
  item: StoreItem;
  canManage: boolean;
}) {
  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          {item.primaryImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={item.primaryImageUrl} alt="" className="h-14 w-14 shrink-0 rounded-lg border border-slate-800 object-cover" />
          ) : null}
          <div>
            <p className="font-semibold text-white">
              {item.name} <span className="ml-1 text-xs font-normal text-slate-500">{money(item.price)}</span>
              {item.supplyMode === "made_to_order" ? (
                <span className="ml-2 rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-200">Por encomenda</span>
              ) : null}
              <span className={`ml-2 rounded-full border px-2 py-0.5 text-[10px] ${item.eventId === null ? "border-(--brand-400)/40 bg-(--brand-500)/10 text-(--brand-200)" : "border-slate-700 bg-slate-900 text-slate-400"}`}>
                {item.eventLabel}
              </span>
            </p>
            {item.description ? <p className="mt-1 text-xs text-slate-400">{item.description}</p> : null}
          </div>
        </div>
        {canManage && contextEventId && contextEventLabel ? (
          <StoreItemForm
            eventId={contextEventId}
            eventLabel={contextEventLabel}
            item={{
              id: item.id,
              name: item.name,
              slug: item.slug,
              description: item.description,
              price: item.price,
              requiresVariant: item.requiresVariant,
              sortOrder: item.sortOrder,
              supplyMode: item.supplyMode,
              availableAllEvents: item.eventId === null,
            }}
          />
        ) : null}
      </div>

      <StoreItemImageGallery storeItemId={item.id} images={item.images} canManage={canManage} />

      {item.requiresVariant ? (
        <div className="mt-3 space-y-2">
          {item.variants.length === 0 ? (
            <p className="text-xs text-slate-500">Nenhuma variante cadastrada ainda.</p>
          ) : (
            item.variants.map((variant) => (
              <div key={variant.id} className="rounded-xl border border-slate-800 bg-slate-900/50 p-2">
                <p className="text-xs font-medium text-slate-200">
                  {variant.name}: {variant.value}
                  {variant.priceAdjustment ? <span className="ml-1 text-slate-500">({variant.priceAdjustment > 0 ? "+" : ""}{money(variant.priceAdjustment)})</span> : null}
                </p>
                {canManage && item.supplyMode === "stock" ? (
                  <div className="mt-1">
                    <StoreStockInput
                      storeItemId={item.id}
                      variantId={variant.id}
                      totalQuantity={variant.totalQuantity}
                      reservedQuantity={variant.reservedQuantity}
                      deliveredQuantity={variant.deliveredQuantity}
                      availableQuantity={variant.availableQuantity}
                    />
                  </div>
                ) : null}
              </div>
            ))
          )}
          {canManage ? <StoreItemVariantForm storeItemId={item.id} /> : null}
        </div>
      ) : canManage && item.supplyMode === "stock" ? (
        <div className="mt-3">
          <StoreStockInput
            storeItemId={item.id}
            variantId={null}
            totalQuantity={item.totalQuantity}
            reservedQuantity={item.reservedQuantity}
            deliveredQuantity={item.deliveredQuantity}
            availableQuantity={item.availableQuantity}
          />
        </div>
      ) : null}
    </div>
  );
}
