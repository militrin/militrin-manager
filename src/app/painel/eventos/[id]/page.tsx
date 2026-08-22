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
import { getEventSingleTicketPriceStatusAction } from "@/app/eventos/actions";
import { SingleTicketPriceManager } from "./single-ticket-price-manager";
import { EventSummaryCard } from "./event-summary-card";
import { BuyerPresentationPreview } from "./buyer-presentation-preview";
import { EventHelpCard, EventResumeCard } from "./event-sidebar-cards";
import { resolveTicketPresentationMode } from "@/lib/checkout/ticket-presentation";
import { EventAddonsManager } from "./addons-manager";
import { EventPaymentMethodsManager } from "./payment-methods-manager";
import { ItemChangeRules } from "./item-change-rules";
import { TicketRules } from "./ticket-rules";
import { DeliveryScheduleManager, type EventScheduleRow } from "./delivery-schedule-manager";
import { EventDataForm } from "./event-data-form";
import { AttractionsManager } from "./attractions-manager";
import { EventWristbandSettings } from "./wristband-settings";
import { ShirtKitConfigurator } from "./shirt-kit-configurator";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ etapa?: string }>;

type BatchCategoryRow = {
  id: string;
  event_id: string;
  name: string;
  sequence_number: number;
  ticket_category_id: string;
  category_name: string;
  male_price: number;
  female_price: number;
  max_confirmed_registrations: number | null;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  confirmed_count: number;
  remaining_slots: number | null;
  created_at: string;
  updated_at: string;
};

export default async function AdminEventDetailsPage({ params, searchParams }: { params: Params; searchParams: SearchParams }) {
  const { id } = await params;
  const resolvedSearchParams = await searchParams;
  const supabase = await createServerSupabaseClient();

  const etapaValue = Number(resolvedSearchParams?.etapa ?? "1");
  const currentStep = Number.isFinite(etapaValue) ? Math.min(9, Math.max(1, Math.trunc(etapaValue))) : 1;

  const [{ data: eventData, error: eventError }, { data: kitData, error: kitError }, { data: categoriesData, error: categoriesError }, { data: addonsData, error: addonsError }, { data: paymentMethodsData, error: paymentMethodsError }, { data: itemRulesData }, { data: scheduleData, error: scheduleError }, { data: attractionsData, error: attractionsError }, { count: ticketsCount, error: ticketsCountError }, { data: shirtConfigData, error: shirtConfigError }] = await Promise.all([
    supabase.from("events").select("id, name, slug, year, description, starts_at, ends_at, registration_open_at, registration_close_at, location, min_age, banner_hero_url, banner_card_url, kit_enabled, registration_enabled, is_active, allow_participant_item_changes, allow_holder_change, allow_ticket_transfer, wristband_enabled, wristband_required_for_checkin, wristband_required_for_kit").eq("id", id).maybeSingle(),
    supabase.rpc("get_event_kit_items", { p_event_id: id }),
    supabase.rpc("get_event_ticket_categories", { p_event_id: id }),
    supabase.rpc("get_event_addons_dynamic_setup", { p_event_id: id }),
    supabase.rpc("get_event_payment_methods_setup", { p_event_id: id }),
    supabase.from("event_kit_items").select("id,name,item_type,requires_variant,allow_participant_change,track_variant_inventory,shirt_supply_mode").eq("event_id", id).order("sort_order"),
    supabase.from('kit_delivery_schedule').select('id,event_id,delivery_at,title,location,description,schedule_type,sort_order,is_active,is_visible_to_users').eq('event_id', id).order('delivery_at'),
    supabase.from('event_attractions').select('id,event_id,name,description,banner_url,is_active,sort_order').eq('event_id', id).order('sort_order'),
    supabase.from('tickets').select('id', { count: 'exact', head: true }).eq('event_id', id).neq('status', 'cancelled'),
    supabase.rpc("get_event_shirt_kit_configuration", { p_event_id: id }),
  ]);

  if (eventError) throw eventError;
  if (kitError) throw kitError;
  if (categoriesError) throw categoriesError;
  if (addonsError) throw addonsError;
  if (paymentMethodsError) throw paymentMethodsError;
  if (ticketsCountError) throw ticketsCountError;
  if (scheduleError) throw scheduleError;
  if (attractionsError) throw attractionsError;
  if (shirtConfigError) throw shirtConfigError;
  if (!eventData?.id) notFound();

  const event = {
    id: String(eventData.id),
    name: String(eventData.name),
    slug: String(eventData.slug),
    year: eventData.year === null || eventData.year === undefined ? null : Number(eventData.year),
    description: eventData.description ? String(eventData.description) : null,
    starts_at: eventData.starts_at ? String(eventData.starts_at) : null,
    ends_at: eventData.ends_at ? String(eventData.ends_at) : null,
    registration_open_at: eventData.registration_open_at ? String(eventData.registration_open_at) : null,
    registration_close_at: eventData.registration_close_at ? String(eventData.registration_close_at) : null,
    location: eventData.location ? String(eventData.location) : null,
    min_age: Number(eventData.min_age ?? 18),
    banner_hero_url: eventData.banner_hero_url ? String(eventData.banner_hero_url) : null,
    banner_card_url: eventData.banner_card_url ? String(eventData.banner_card_url) : null,
    kit_enabled: Boolean(eventData.kit_enabled),
    registration_enabled: Boolean(eventData.registration_enabled),
    is_active: Boolean(eventData.is_active),
    allow_participant_item_changes: Boolean(eventData.allow_participant_item_changes),
    allow_holder_change: Boolean(eventData.allow_holder_change),
    allow_ticket_transfer: Boolean(eventData.allow_ticket_transfer),
    wristband_enabled: Boolean(eventData.wristband_enabled),
    wristband_required_for_checkin: Boolean(eventData.wristband_required_for_checkin),
    wristband_required_for_kit: Boolean(eventData.wristband_required_for_kit),
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

  const shirtConfigRows = (shirtConfigData ?? []) as Array<{
    shirt_supply_mode: string | null;
    is_required: boolean | null;
    quantity_per_participant: number | null;
    variant_id: string | null;
    shirt_type: string | null;
    shirt_size: string | null;
    variant_is_active: boolean | null;
    kit_total_quantity: number | null;
    kit_reserved_quantity: number | null;
    kit_delivered_quantity: number | null;
    stock_total_quantity: number | null;
    stock_reserved_quantity: number | null;
    stock_delivered_quantity: number | null;
  }>;
  const shirtConfigHead = shirtConfigRows[0];
  const shirtKitConfigInitial = {
    supplyMode: (shirtConfigHead?.shirt_supply_mode === "made_to_order" || shirtConfigHead?.shirt_supply_mode === "disabled"
      ? shirtConfigHead.shirt_supply_mode
      : "stock") as "stock" | "made_to_order" | "disabled",
    isRequired: Boolean(shirtConfigHead?.is_required ?? false),
    quantityPerParticipant: Number(shirtConfigHead?.quantity_per_participant ?? 1),
    variants: shirtConfigRows
      .filter((row) => row.variant_id)
      .map((row) => ({
        variantId: String(row.variant_id),
        shirtType: (row.shirt_type === "Babylook" ? "Babylook" : "Camiseta") as "Camiseta" | "Babylook",
        shirtSize: String(row.shirt_size ?? ""),
        isActive: Boolean(row.variant_is_active),
        kitTotal: Number(row.kit_total_quantity ?? 0),
        kitReserved: Number(row.kit_reserved_quantity ?? 0),
        kitDelivered: Number(row.kit_delivered_quantity ?? 0),
        stockTotal: Number(row.stock_total_quantity ?? 0),
        stockReserved: Number(row.stock_reserved_quantity ?? 0),
        stockDelivered: Number(row.stock_delivered_quantity ?? 0),
      })),
  };

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
    current_batch_name: string | null;
    current_male_price: number | null;
    current_female_price: number | null;
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
    current_batch_name: row.current_batch_name ? String(row.current_batch_name) : null,
    current_male_price: row.current_male_price === null || row.current_male_price === undefined ? null : Number(row.current_male_price),
    current_female_price: row.current_female_price === null || row.current_female_price === undefined ? null : Number(row.current_female_price),
  }));

  const activeCategoryCount = categories.filter((category: { is_active: boolean }) => category.is_active).length;
  const activeCategoriesForPreview = categories.filter((category: { is_active: boolean }) => category.is_active);
  const ticketMode = resolveTicketPresentationMode(activeCategoryCount);
  const ticketModeLabel = ticketMode === "single"
    ? "Ingresso único (sem categoria)"
    : ticketMode === "category_hidden"
      ? "1 categoria ativa — o comprador só vê o lote"
      : `${activeCategoryCount} categorias ativas — o comprador escolhe a categoria`;
  let singleTicketPriceStatus: { male_price: number | null; female_price: number | null; price_confirmed: boolean; registration_enabled: boolean } | null = null;
  if ((currentStep === 2 || currentStep === 3) && activeCategoryCount === 0) {
    const statusResult = await getEventSingleTicketPriceStatusAction(event.id);
    singleTicketPriceStatus = statusResult.success
      ? statusResult.status
      : { male_price: null, female_price: null, price_confirmed: false, registration_enabled: event.registration_enabled };
  }

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

  const batches = (batchesData ?? []).map((row: {
    id: string; event_id: string; name: string; sequence_number: number;
    ticket_category_id: string; category_name: string; male_price: number; female_price: number;
    max_confirmed_registrations: number | null; starts_at: string | null; ends_at: string | null; is_active: boolean;
    confirmed_count: number; remaining_slots: number | null; created_at: string; updated_at: string;
  }) => ({
    id: String(row.id),
    event_id: String(row.event_id),
    name: String(row.name),
    sequence_number: Number(row.sequence_number ?? 0),
    ticket_category_id: String(row.ticket_category_id),
    category_name: String(row.category_name),
    male_price: Number(row.male_price ?? 0),
    female_price: Number(row.female_price ?? 0),
    max_confirmed_registrations: row.max_confirmed_registrations === null || row.max_confirmed_registrations === undefined ? null : Number(row.max_confirmed_registrations),
    starts_at: row.starts_at ? String(row.starts_at) : null,
    ends_at: row.ends_at ? String(row.ends_at) : null,
    is_active: Boolean(row.is_active),
    confirmed_count: Number(row.confirmed_count ?? 0),
    remaining_slots: row.remaining_slots === null || row.remaining_slots === undefined ? null : Number(row.remaining_slots),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  })) as BatchCategoryRow[];

  const totalBatchCount = new Set(batches.map((row) => row.id)).size;

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
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title={`Evento: ${event.name}`} subtitle="Fluxo sequencial: dados do evento, categorias/lotes e adicionais" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Eventos",href:"/painel/eventos"},{label:String(event.name)}]} backHref="/painel/eventos" fallbackHref="/painel/eventos" />

          <EventSummaryCard
            event={{
              id: event.id,
              name: event.name,
              year: event.year,
              description: event.description,
              starts_at: event.starts_at,
              ends_at: event.ends_at,
              location: event.location,
              is_active: event.is_active,
              registration_enabled: event.registration_enabled,
              banner_card_url: event.banner_card_url,
              banner_hero_url: event.banner_hero_url,
              participants_count: Number(ticketsCount ?? 0),
            }}
          />

          <div className="rounded-2xl border border-slate-800/80 bg-slate-900/50 p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap gap-1.5">
                {[
                  { step: 1, label: "Dados" },
                  { step: 2, label: "Categorias" },
                  { step: 3, label: "Lotes" },
                  { step: 4, label: "Adicionais" },
                  { step: 5, label: "Pagamentos" },
                  { step: 6, label: "Itens de kit" },
                  { step: 7, label: "Cronograma" },
                  { step: 8, label: "Atrações" },
                  { step: 9, label: "Acesso e pulseiras" },
                ].map((item) => (
                  <Link
                    key={item.step}
                    href={`/painel/eventos/${event.id}?etapa=${item.step}`}
                    className={`rounded-lg border px-2.5 py-1.5 text-center text-[11px] whitespace-nowrap transition ${
                      currentStep === item.step
                        ? "border-emerald-500/50 bg-emerald-500/15 font-medium text-emerald-200"
                        : "border-slate-700 bg-slate-950/60 text-slate-400 hover:border-slate-600 hover:text-slate-200"
                    }`}
                  >
                    {item.step}. {item.label}
                  </Link>
                ))}
              </div>

              <div className="flex shrink-0 justify-end gap-2">
                {currentStep > 1 ? (
                  <Link href={`/painel/eventos/${event.id}?etapa=${currentStep - 1}`} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500">
                    ← Voltar etapa
                  </Link>
                ) : null}
                {currentStep < 9 ? (
                  <Link href={`/painel/eventos/${event.id}?etapa=${currentStep + 1}`} className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-200 hover:border-emerald-400">
                    Próxima etapa →
                  </Link>
                ) : null}
              </div>
            </div>
          </div>

          {currentStep === 1 ? (
            <SectionCard title="Etapa 1: Dados básicos" description="Nome, data, descrição, local, banners e regras do ingresso deste evento.">
              <div className="space-y-4">
                <EventDataForm mode="edit" event={event} />
                <TicketRules eventId={event.id} initialHolderChange={event.allow_holder_change} initialTicketTransfer={event.allow_ticket_transfer} />
              </div>
            </SectionCard>
          ) : null}

          {currentStep === 2 ? (
            <SectionCard title="Etapa 2: Categorias do evento" description="Defina categorias que poderão ser usadas nos lotes deste evento.">
              <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-300">
                Modelo detectado: <strong className="text-slate-100">{ticketModeLabel}</strong>
              </div>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
                <CategoriesManager eventId={event.id} categories={categories} benefits={benefits} />
                <div className="space-y-4">
                  <BuyerPresentationPreview
                    event={{ name: event.name, starts_at: event.starts_at, location: event.location, banner_card_url: event.banner_card_url, banner_hero_url: event.banner_hero_url }}
                    activeCategories={activeCategoriesForPreview}
                    singleTicketPrice={singleTicketPriceStatus}
                  />
                  <EventResumeCard data={{ ticketModeLabel, activeCategoryCount, totalCategoryCount: categories.length, totalBatchCount, ticketsCount: Number(ticketsCount ?? 0) }} />
                  <EventHelpCard step={currentStep} />
                </div>
              </div>
            </SectionCard>
          ) : null}

          {currentStep === 3 ? (
            <SectionCard
              title="Etapa 3: Lotes do evento"
              description={activeCategoryCount === 0
                ? "Este evento não tem categoria ativa: defina o preço do ingresso único."
                : "Crie e edite lotes com preço unissex ou por gênero e categorias ativas por lote."}
            >
              <div className="mb-4 rounded-xl border border-slate-800 bg-slate-900/50 px-3 py-2 text-xs text-slate-300">
                Modelo detectado: <strong className="text-slate-100">{ticketModeLabel}</strong>
              </div>
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_310px]">
                {activeCategoryCount === 0 && singleTicketPriceStatus ? (
                  <SingleTicketPriceManager eventId={event.id} initialStatus={singleTicketPriceStatus} />
                ) : (
                  <BatchesManager eventId={event.id} batches={batches} categories={categories} />
                )}
                <div className="space-y-4">
                  <BuyerPresentationPreview
                    event={{ name: event.name, starts_at: event.starts_at, location: event.location, banner_card_url: event.banner_card_url, banner_hero_url: event.banner_hero_url }}
                    activeCategories={activeCategoriesForPreview}
                    singleTicketPrice={singleTicketPriceStatus}
                  />
                  <EventResumeCard data={{ ticketModeLabel, activeCategoryCount, totalCategoryCount: categories.length, totalBatchCount, ticketsCount: Number(ticketsCount ?? 0) }} />
                  <EventHelpCard step={currentStep} />
                </div>
              </div>
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
            <SectionCard title="Etapa 6: Itens e variações de kit" description="Opcional: detalhar itens físicos entregáveis (camiseta, copo, tirante etc.), variações e regras de alteração do kit utilizado no evento.">
              <ItemChangeRules eventId={event.id} initialEnabled={event.allow_participant_item_changes} items={(itemRulesData ?? []).map((item) => ({ id: String(item.id), name: String(item.name), item_type: String(item.item_type), requires_variant: Boolean(item.requires_variant), allow_participant_change: Boolean(item.allow_participant_change), track_variant_inventory: Boolean(item.track_variant_inventory), require_stock_for_choice: item.shirt_supply_mode === "stock" }))} />
              {!event.kit_enabled ? (
                <EmptyState title="Kit desabilitado" description="Ative 'Possui kit' no cadastro do evento para usar itens de kit." />
              ) : (
                <div className="space-y-4">
                  <ShirtKitConfigurator eventId={event.id} initial={shirtKitConfigInitial} />
                  <EventKitManager event={event} items={items.filter((item: { item_type: string }) => item.item_type !== "shirt")} />
                </div>
              )}
            </SectionCard>
          ) : null}
          {currentStep === 7 ? (
            <SectionCard title="Etapa 7: Cronograma do evento" description="Cadastre compromissos deste evento e controle sua visibilidade no portal do usuário.">
              <DeliveryScheduleManager eventId={event.id} initialRows={(scheduleData ?? []).map((row) => ({
                id: String(row.id), event_id: String(row.event_id), delivery_at: String(row.delivery_at), title: String(row.title),
                location: row.location ? String(row.location) : null, description: row.description ? String(row.description) : null,
                schedule_type: String(row.schedule_type), sort_order: Number(row.sort_order ?? 0),
                is_active: Boolean(row.is_active), is_visible_to_users: Boolean(row.is_visible_to_users),
              })) as EventScheduleRow[]} />
            </SectionCard>
          ) : null}

          {currentStep === 8 ? (
            <SectionCard title="Etapa 8: Atrações" description="Cadastre as atrações (line-up) deste evento. O link 'Ver atrações' só aparece na página pública quando houver ao menos uma atração ativa.">
              <AttractionsManager eventId={event.id} attractions={(attractionsData ?? []).map((row) => ({
                id: String(row.id), event_id: String(row.event_id), name: String(row.name),
                description: row.description ? String(row.description) : null,
                banner_url: row.banner_url ? String(row.banner_url) : null,
                is_active: Boolean(row.is_active), sort_order: Number(row.sort_order ?? 0),
              }))} />
            </SectionCard>
          ) : null}

          {currentStep === 9 ? (
            <SectionCard title="Etapa 9: Acesso e pulseiras" description="Configuração operacional/de acesso do evento: uso de pulseiras vinculadas ao ingresso e exigências no check-in e na entrega do kit.">
              <EventWristbandSettings
                eventId={event.id}
                initial={{
                  enabled: event.wristband_enabled,
                  requiredForCheckin: event.wristband_required_for_checkin,
                  requiredForKit: event.wristband_required_for_kit,
                }}
              />
            </SectionCard>
          ) : null}
        </div>
      </div>
    </main>
  );
}
