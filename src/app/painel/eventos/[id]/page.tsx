import Link from "next/link";
import { notFound } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EmptyState } from "@/components/mvp/EmptyState";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { EventKitManager } from "@/app/eventos/[eventSlug]/ui";
import { CategoriesManager } from "@/app/categorias/ui";
import { BatchesManager } from "@/app/lotes/ui";
import { EventAddonsManager } from "./addons-manager";
import { EventPaymentMethodsManager } from "./payment-methods-manager";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ etapa?: string }>;

type BatchRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number;
  created_at: string;
  updated_at: string;
};

export default async function AdminEventDetailsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const supabase = await createServerSupabaseClient();

  const etapaValue = Number(resolvedSearchParams?.etapa ?? "1");
  const currentStep = Number.isFinite(etapaValue) ? Math.min(6, Math.max(1, Math.trunc(etapaValue))) : 1;

  const [{ data: eventData, error: eventError }, { data: kitData, error: kitError }, { data: categoriesData, error: categoriesError }, { data: addonsData, error: addonsError }, { data: paymentMethodsData, error: paymentMethodsError }] = await Promise.all([
    supabase.from("events").select("id, name, slug, year, kit_enabled, registration_enabled, is_active").eq("id", id).maybeSingle(),
    supabase.rpc("get_event_kit_items", { p_event_id: id }),
    supabase.rpc("get_event_ticket_categories", { p_event_id: id }),
    supabase.rpc("get_event_addons_dynamic_setup", { p_event_id: id }),
    supabase.rpc("get_event_payment_methods_setup", { p_event_id: id }),
  ]);

  if (eventError) throw eventError;
  if (kitError) throw kitError;
  if (categoriesError) throw categoriesError;
  if (addonsError) throw addonsError;
  if (paymentMethodsError) throw paymentMethodsError;
  if (!eventData?.id) notFound();

  const event = {
    id: String(eventData.id),
    name: String(eventData.name),
    slug: String(eventData.slug),
    year: eventData.year === null || eventData.year === undefined ? null : Number(eventData.year),
    kit_enabled: Boolean(eventData.kit_enabled),
    registration_enabled: Boolean(eventData.registration_enabled),
    is_active: Boolean(eventData.is_active),
  };

  const items = (kitData ?? []).map((row: {
    id: string;
    event_id: string;
    name: string;
    slug: string;
    description: string | null;
    item_type: string;
    quantity_per_participant: number;
    requires_variant: boolean;
    is_required: boolean;
    is_active: boolean;
    sort_order: number;
    variants: Array<{
      id: string;
      name: string;
      value: string;
      sort_order: number;
      is_active: boolean;
    }> | null;
  }) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    item_type: String(row.item_type),
    quantity_per_participant: Number(row.quantity_per_participant ?? 1),
    requires_variant: Boolean(row.requires_variant),
    is_required: Boolean(row.is_required),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    variants: Array.isArray(row.variants)
      ? row.variants.map((variant) => ({
          id: String(variant.id),
          name: String(variant.name),
          value: String(variant.value),
          sort_order: Number(variant.sort_order ?? 0),
          is_active: Boolean(variant.is_active),
        }))
      : [],
  }));

  const categories = (categoriesData ?? []).map((row: {
    id: string;
    event_id: string;
    name: string;
    slug: string;
    description: string | null;
    capacity: number | null;
    is_active: boolean;
    sort_order: number;
    confirmed_count: number;
    pending_count: number;
    reserved_count: number;
    available_slots: number | null;
  }) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    name: String(row.name),
    slug: String(row.slug),
    description: row.description ? String(row.description) : null,
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    is_active: Boolean(row.is_active),
    sort_order: Number(row.sort_order ?? 0),
    confirmed_count: Number(row.confirmed_count ?? 0),
    pending_count: Number(row.pending_count ?? 0),
    reserved_count: Number(row.reserved_count ?? 0),
    available_slots: row.available_slots === null || row.available_slots === undefined ? null : Number(row.available_slots),
  }));

  const categoryIds = categories.map((category: { id: string }) => category.id);
  const { data: benefitsData, error: benefitsError } = categoryIds.length > 0
    ? await supabase
        .from("ticket_category_benefits")
        .select("id, ticket_category_id, name, description, sort_order")
        .in("ticket_category_id", categoryIds)
        .order("sort_order", { ascending: true })
        .order("created_at", { ascending: true })
    : { data: [], error: null };

  if (benefitsError) throw benefitsError;

  const { data: batchesData, error: batchesError } = await supabase.rpc("get_registration_batches", {
    p_event_id: id,
  });

  if (batchesError) throw batchesError;

  const batches = (batchesData ?? []) as BatchRow[];
  const batchIds = batches.map((batch) => String(batch.id));

  const { data: batchCategoryPricesData, error: batchCategoryPricesError } = batchIds.length > 0
    ? await supabase
        .from("registration_batch_prices")
        .select("batch_id, ticket_category_id, male_price, female_price")
        .in("batch_id", batchIds)
    : { data: [], error: null };

  if (batchCategoryPricesError) throw batchCategoryPricesError;

  const batchCategoryPrices = (batchCategoryPricesData ?? []).map((row: {
    batch_id: string;
    ticket_category_id: string;
    male_price: number;
    female_price: number;
  }) => ({
    batch_id: String(row.batch_id),
    ticket_category_id: String(row.ticket_category_id),
    male_price: Number(row.male_price ?? 0),
    female_price: Number(row.female_price ?? 0),
  }));

  const benefits = (benefitsData ?? []).map((row: {
    id: string;
    ticket_category_id: string;
    name: string;
    description: string | null;
    sort_order: number;
  }) => ({
    id: String(row.id),
    ticket_category_id: String(row.ticket_category_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    sort_order: Number(row.sort_order ?? 0),
  }));

  const addonRows = (addonsData ?? []) as Array<{
    apply_to_all_batches: boolean;
    option_id: string | null;
    option_name: string | null;
    option_description: string | null;
    option_sort_order: number | null;
    option_is_active: boolean | null;
    batch_id: string | null;
    batch_name: string | null;
    batch_sequence_number: number | null;
    batch_option_enabled: boolean | null;
  }>;

  const applyToAllBatches = Boolean(addonRows[0]?.apply_to_all_batches ?? true);

  const addonOptionsMap = new Map<string, { id: string; name: string; description: string | null; sort_order: number; is_active: boolean }>();
  const batchesMap = new Map<string, { id: string; name: string; sequence_number: number }>();
  const assignmentsMap = new Map<string, boolean>();

  for (const row of addonRows) {
    if (row.option_id) {
      addonOptionsMap.set(String(row.option_id), {
        id: String(row.option_id),
        name: String(row.option_name ?? ""),
        description: row.option_description ? String(row.option_description) : null,
        sort_order: Number(row.option_sort_order ?? 0),
        is_active: Boolean(row.option_is_active ?? true),
      });
    }

    if (row.batch_id) {
      batchesMap.set(String(row.batch_id), {
        id: String(row.batch_id),
        name: row.batch_name ? String(row.batch_name) : "",
        sequence_number: Number(row.batch_sequence_number ?? 0),
      });
    }

    if (row.batch_id && row.option_id) {
      assignmentsMap.set(`${String(row.batch_id)}:${String(row.option_id)}`, Boolean(row.batch_option_enabled));
    }
  }

  const addonOptions = Array.from(addonOptionsMap.values()).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const addonBatches = Array.from(batchesMap.values()).sort((a, b) => a.sequence_number - b.sequence_number);
  const addonAssignments = Object.fromEntries(assignmentsMap.entries());

  const paymentMethodsRow = Array.isArray(paymentMethodsData)
    ? (paymentMethodsData[0] as Record<string, unknown> | undefined)
    : (paymentMethodsData as Record<string, unknown> | null);

  const paymentMethodsConfig = {
    pix_enabled: Boolean(paymentMethodsRow?.pix_enabled ?? true),
    credit_card_single_enabled: Boolean(paymentMethodsRow?.credit_card_single_enabled ?? true),
    credit_card_installments_enabled: Boolean(paymentMethodsRow?.credit_card_installments_enabled ?? true),
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.18),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title={`Evento: ${event.name}`} subtitle="Fluxo sequencial: dados do evento, categorias/lotes e adicionais" />

          <SectionCard title="Etapas de configuração" description="Siga a sequência para concluir o evento sem pular etapas.">
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-6">
                {[
                  { step: 1, label: "Dados" },
                  { step: 2, label: "Categorias" },
                  { step: 3, label: "Lotes" },
                  { step: 4, label: "Adicionais" },
                  { step: 5, label: "Pagamentos" },
                  { step: 6, label: "Itens de kit" },
                ].map((item) => (
                  <Link
                    key={item.step}
                    href={`/painel/eventos/${event.id}?etapa=${item.step}`}
                    className={`rounded-xl border px-3 py-2 text-center text-xs ${
                      currentStep === item.step
                        ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-200"
                        : "border-slate-700 bg-slate-950/60 text-slate-300"
                    }`}
                  >
                    {item.step}. {item.label}
                  </Link>
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {currentStep > 1 ? (
                  <Link href={`/painel/eventos/${event.id}?etapa=${currentStep - 1}`} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">
                    Voltar etapa
                  </Link>
                ) : null}
                {currentStep < 6 ? (
                  <Link href={`/painel/eventos/${event.id}?etapa=${currentStep + 1}`} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200">
                    Próxima etapa
                  </Link>
                ) : null}
              </div>
            </div>
          </SectionCard>

          {currentStep === 1 ? (
            <SectionCard title="Etapa 1: Dados básicos" description="Nome, data, descrição e local são definidos ao criar/editar o evento na tela principal de eventos.">
              <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                <p>Evento: <span className="font-semibold text-slate-100">{event.name}</span></p>
                <p className="mt-1">Slug: <span className="text-slate-200">{event.slug}</span></p>
                <p className="mt-1">Status: <span className="text-slate-200">{event.is_active ? "Ativo" : "Inativo"}</span></p>
                <p className="mt-3 text-xs text-slate-400">Se precisar alterar dados básicos, use o botão Editar na listagem de eventos.</p>
                <Link href="/painel/eventos" className="mt-3 inline-flex rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">
                  Voltar para listagem de eventos
                </Link>
              </div>
            </SectionCard>
          ) : null}

          {currentStep === 2 ? (
            <SectionCard title="Etapa 2: Categorias do evento" description="Defina categorias que poderão ser usadas nos lotes deste evento.">
              <CategoriesManager eventId={event.id} categories={categories} benefits={benefits} />
            </SectionCard>
          ) : null}

          {currentStep === 3 ? (
            <SectionCard title="Etapa 3: Lotes do evento" description="Crie e edite lotes com preço unissex ou por gênero e categorias ativas por lote.">
              {categories.length === 0 ? (
                <EmptyState title="Nenhuma categoria cadastrada" description="Crie ao menos uma categoria antes de configurar lotes." />
              ) : (
                <BatchesManager eventId={event.id} batches={batches} categories={categories} batchCategoryPrices={batchCategoryPrices} />
              )}
            </SectionCard>
          ) : null}

          {currentStep === 4 ? (
            <SectionCard title="Etapa 4: Adicionais do evento" description="Cadastre os adicionais que desejar e escolha se valem para todos os lotes ou apenas para lotes específicos.">
              <EventAddonsManager
                eventId={event.id}
                initialApplyToAllBatches={applyToAllBatches}
                options={addonOptions}
                batches={addonBatches}
                assignments={addonAssignments}
              />
            </SectionCard>
          ) : null}

          {currentStep === 5 ? (
            <SectionCard title="Etapa 5: Formas de pagamento" description="Defina quais opcoes de pagamento ficam disponiveis no checkout deste evento.">
              <EventPaymentMethodsManager eventId={event.id} initialConfig={paymentMethodsConfig} />
            </SectionCard>
          ) : null}

          {currentStep === 6 ? (
            <SectionCard title="Etapa 6: Itens e variações de kit" description="Opcional: detalhar itens e variações de kit utilizados no evento.">
              {!event.kit_enabled ? (
                <EmptyState title="Kit desabilitado" description="Ative 'Possui kit' no cadastro do evento para usar itens de kit." />
              ) : (
                <EventKitManager event={event} items={items} />
              )}
            </SectionCard>
          ) : null}
        </div>
      </div>
    </main>
  );
}
