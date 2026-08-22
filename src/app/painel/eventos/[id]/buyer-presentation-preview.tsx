import { resolveTicketPresentationMode } from "@/lib/checkout/ticket-presentation";
import { formatDateBR } from "@/lib/utils/date";

function money(value: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0);
}

function priceLabel(malePrice: number | null, femalePrice: number | null) {
  if (malePrice === null && femalePrice === null) return "Preço a definir";
  if (malePrice !== null && femalePrice !== null && malePrice === femalePrice) return money(malePrice);
  const parts: string[] = [];
  if (malePrice !== null) parts.push(`${money(malePrice)} masc.`);
  if (femalePrice !== null) parts.push(`${money(femalePrice)} fem.`);
  return parts.join(" / ");
}

export type BuyerPreviewCategory = {
  id: string;
  name: string;
  current_batch_name: string | null;
  current_male_price: number | null;
  current_female_price: number | null;
};

export type BuyerPreviewSingleTicketPrice = {
  male_price: number | null;
  female_price: number | null;
  price_confirmed: boolean;
  male_batch_label?: string | null;
  female_batch_label?: string | null;
  same_batch?: boolean;
};

export type BuyerPreviewEvent = {
  name: string;
  starts_at: string | null;
  location: string | null;
  banner_card_url: string | null;
  banner_hero_url: string | null;
};

// Mesma regra do checkout publico (resolveTicketPresentationMode), para que o
// admin veja exatamente o que o comprador vai ver — nunca uma aproximacao.
export function BuyerPresentationPreview({
  event,
  activeCategories,
  singleTicketPrice,
}: {
  event: BuyerPreviewEvent;
  activeCategories: BuyerPreviewCategory[];
  singleTicketPrice: BuyerPreviewSingleTicketPrice | null;
}) {
  const mode = resolveTicketPresentationMode(activeCategories.length);
  const bannerUrl = event.banner_card_url || event.banner_hero_url;

  return (
    <aside className="h-fit overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/60">
      <div className="border-b border-slate-800 px-4 py-3">
        <p className="text-sm font-semibold text-slate-200">Como o comprador verá</p>
        <p className="mt-0.5 text-[11px] text-slate-500">Mesma regra do checkout público.</p>
      </div>

      <div className="overflow-hidden">
        <div className="h-28 w-full bg-slate-900">
          {bannerUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-slate-600">Sem banner</div>
          )}
        </div>

        <div className="space-y-3 p-4">
          <div>
            <p className="text-sm font-semibold text-slate-100">{event.name}</p>
            <p className="text-xs text-slate-400">
              {event.starts_at ? formatDateBR(event.starts_at) : "Data a definir"}
              {event.location ? ` · ${event.location}` : ""}
            </p>
          </div>

          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Ingresso disponível</p>

            <div className="mt-2 space-y-2">
              {mode === "single" ? (
                singleTicketPrice?.price_confirmed ? (
                  singleTicketPrice.same_batch === false ? (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                        <span className="text-sm text-slate-200">Masculino — {singleTicketPrice.male_batch_label ?? "lote a definir"}</span>
                        <span className="text-sm font-semibold text-emerald-300">{singleTicketPrice.male_price !== null ? money(singleTicketPrice.male_price) : "—"}</span>
                      </div>
                      <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                        <span className="text-sm text-slate-200">Feminino — {singleTicketPrice.female_batch_label ?? "lote a definir"}</span>
                        <span className="text-sm font-semibold text-emerald-300">{singleTicketPrice.female_price !== null ? money(singleTicketPrice.female_price) : "—"}</span>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                      <span className="text-sm text-slate-200">Ingresso único{singleTicketPrice.male_batch_label ? ` — ${singleTicketPrice.male_batch_label}` : ""}</span>
                      <span className="text-sm font-semibold text-emerald-300">{priceLabel(singleTicketPrice.male_price, singleTicketPrice.female_price)}</span>
                    </div>
                  )
                ) : (
                  <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">Preço do ingresso único ainda não configurado.</p>
                )
              ) : mode === "category_hidden" ? (
                <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                  <span className="text-sm text-slate-200">{activeCategories[0]?.current_batch_name || "Lote a definir"}</span>
                  <span className="text-sm font-semibold text-emerald-300">{priceLabel(activeCategories[0]?.current_male_price ?? null, activeCategories[0]?.current_female_price ?? null)}</span>
                </div>
              ) : (
                activeCategories.map((category) => (
                  <div key={category.id} className="rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2.5">
                    <p className="text-xs font-medium text-slate-400">{category.name}</p>
                    <div className="mt-1 flex items-center justify-between gap-3">
                      <span className="text-sm text-slate-200">{category.current_batch_name || "Lote a definir"}</span>
                      <span className="text-sm font-semibold text-emerald-300">{priceLabel(category.current_male_price, category.current_female_price)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
