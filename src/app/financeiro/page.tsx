import Link from "next/link";
import type { ReactNode } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { EventContextSelector } from "@/components/admin/EventContextSelector";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { formatDateTimeBR } from "@/lib/utils/date";
import { FinancialActionForm } from "./financial-action-form";
import { FinancialOverviewFilters } from "./overview-filters";
import { ComparisonEventSelector } from "./comparison-event-selector";
import { FinancialOverviewControls } from "./overview-controls";
import { ComparisonRowLabel } from "./comparison-row-label";
import {
  createSimpleFinancialExpenseAction, initializeSimpleFinanceAction, reverseFinancialEntryAction,
  settleSimpleFinancialExpenseAction, upsertFinancialCategoryAction, upsertFinancialSupplierAction,
  removeFinancialCategoryAction, removeFinancialSupplierAction,
} from "./actions";

const tabs = [
  ["overview", "Visão geral"], ["sales", "Receitas"], ["expenses", "Despesas"],
  ["payable", "Contas a pagar"], ["paid", "Contas pagas"], ["refunds", "Estornos"],
  ["settings", "Configurações"],
] as const;
type Tab = (typeof tabs)[number][0];
const statusOptions = ["pending", "paid", "cancelled", "expired", "courtesy"] as const;
const statusLabels = { pending: "Pendentes", paid: "Confirmados", cancelled: "Cancelados", expired: "Expirados", courtesy: "Cortesias" };
const field = "w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100";
type Account = { id: string; code: string; name: string; account_type: string; is_active: boolean };
type Category = { id: string; name: string; entry_kind: string; is_active: boolean };
type Supplier = { id: string; legal_name: string; display_name: string | null; tax_identifier: string | null; is_active: boolean };
type Entry = { id: string; entry_kind: string; lifecycle_status: string; description: string; amount: number; due_date: string | null; occurred_on: string; posted_at: string | null };
type Settlement = { id: string; expense_entry_id: string; amount: number; paid_on: string; reason: string | null };
type Reversal = { id: string; original_entry_id: string; amount: number; created_at: string };
type Allocation = { entry_id: string; event_id: string; amount: number };
type TicketMetric = { eventId: string; issuedAt: string; kind: "sold" | "courtesy" };
type PaymentRow = { id: string; final_amount: number; payment_method: string; payment_status: string; created_at: string; paid_at: string | null; participants: { full_name?: string; cpf?: string } | { full_name?: string; cpf?: string }[] | null };

async function loadContext(eventId: string | null) {
  const supabase = await createServerSupabaseClient();
  const { data: events } = await supabase.from("events").select("id,name,is_active,organization_id").is("archived_at", null).order("starts_at", { ascending: false });
  const selected = eventId ? (events ?? []).find((event) => event.id === eventId) ?? null : null;
  const organizationIds = [...new Set((events ?? []).map((event) => String(event.organization_id)))];
  const organizationId = selected ? String(selected.organization_id) : organizationIds.length === 1 ? organizationIds[0] : null;
  return { supabase, events: events ?? [], selected, organizationId };
}

async function loadSales(status: string, eventId: string | null) {
  const context = await loadContext(eventId);
  if (!context.selected) return { ...context, rows: [] };
  const paymentStatus = status === "courtesy" ? "paid" : status;
  let query = context.supabase.from("payments")
    .select("id,amount,discount_amount,final_amount,payment_method,payment_status,created_at,paid_at,participants!inner(full_name,cpf)")
    .eq("event_id", context.selected.id).eq("payment_status", paymentStatus).order("created_at", { ascending: false }).limit(200);
  if (status === "courtesy") query = query.eq("payment_method", "courtesy");
  const { data } = await query;
  return { ...context, rows: data ?? [] };
}

async function loadLedger(eventId: string | null, includeAllEvents = false) {
  const context = await loadContext(eventId);
  if (!context.organizationId) return { ...context, available: false, simpleAvailable: false, accounts: [], categories: [], suppliers: [], entries: [], settlements: [], reversals: [], allocations: [], ticketMetrics: [] };
  const organizationId = context.organizationId;
  const [accounts, categories, suppliers, entries, settlements, reversals, allocations, tickets, orders, payments] = await Promise.all([
    context.supabase.from("financial_accounts").select("id,code,name,account_type,is_active").eq("organization_id", organizationId).order("code"),
    context.supabase.from("financial_categories").select("id,name,entry_kind,is_active").eq("organization_id", organizationId).order("name"),
    context.supabase.from("financial_suppliers").select("id,legal_name,display_name,tax_identifier,is_active").eq("organization_id", organizationId).order("legal_name"),
    context.supabase.from("financial_entries").select("id,entry_kind,lifecycle_status,description,amount,due_date,occurred_on,posted_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(2000),
    context.supabase.from("financial_entry_settlements").select("id,expense_entry_id,amount,paid_on,reason").eq("organization_id", organizationId).order("paid_on", { ascending: false }).limit(500),
    context.supabase.from("financial_reversals").select("id,original_entry_id,amount,created_at").eq("organization_id", organizationId).order("created_at", { ascending: false }).limit(500),
    context.supabase.from("financial_event_allocations").select("entry_id,event_id,amount").eq("organization_id", organizationId),
    context.supabase.from("tickets").select("id,event_id,status,issued_at,order_id").eq("organization_id", organizationId).neq("status", "cancelled").range(0, 4999),
    context.supabase.from("orders").select("id,event_id,payment_id").eq("organization_id", organizationId).range(0, 4999),
    context.supabase.from("payments").select("id,payment_method,payment_status").eq("organization_id", organizationId).range(0, 4999),
  ]);
  const error = accounts.error ?? categories.error ?? suppliers.error ?? entries.error ?? reversals.error ?? allocations.error ?? tickets.error ?? orders.error ?? payments.error;
  const applicableAllocations = (allocations.data ?? []).filter((row) => includeAllEvents || !context.selected || String(row.event_id) === String(context.selected.id)) as Allocation[];
  const eventEntryIds = new Set(applicableAllocations.map((row) => String(row.entry_id)));
  const eventEntries = (entries.data ?? []).filter((entry) => eventEntryIds.has(String(entry.id))) as Entry[];
  const eventIds = new Set(eventEntries.map((entry) => entry.id));
  const paymentById = new Map((payments.data ?? []).map((payment) => [String(payment.id), payment]));
  const orderById = new Map((orders.data ?? []).map((order) => [String(order.id), order]));
  const ticketMetrics = (tickets.data ?? []).flatMap((ticket) => {
    const order=orderById.get(String(ticket.order_id)); const payment=order?.payment_id ? paymentById.get(String(order.payment_id)) : null;
    if (!payment || String(payment.payment_status)!=="paid") return [];
    return [{ eventId:String(ticket.event_id), issuedAt:String(ticket.issued_at), kind:String(payment.payment_method).toLowerCase()==="courtesy" ? "courtesy" : "sold" }] as TicketMetric[];
  });
  return { ...context, available: !error, simpleAvailable: !settlements.error, accounts: (accounts.data ?? []) as Account[], categories: (categories.data ?? []) as Category[], suppliers: (suppliers.data ?? []) as Supplier[], entries: eventEntries, settlements: (settlements.data ?? []).filter((row) => eventIds.has(String(row.expense_entry_id))) as Settlement[], reversals: (reversals.data ?? []).filter((row) => eventIds.has(String(row.original_entry_id))) as Reversal[], allocations: applicableAllocations, ticketMetrics };
}

function Tabs({ active, eventId, status }: { active: Tab; eventId: string | null; status: string }) {
  return <nav className="flex flex-wrap gap-2" aria-label="Áreas financeiras">{tabs.map(([code, label]) => {
    const params = new URLSearchParams({ tab: code }); if (eventId) params.set("eventId", eventId); if (code === "sales") params.set("status", status);
    return <Link key={code} href={`/financeiro?${params}`} className={`rounded-xl border px-3 py-2 text-sm ${active === code ? "border-emerald-400 bg-emerald-500/15 text-emerald-200" : "border-slate-700 text-slate-300"}`}>{label}</Link>;
  })}</nav>;
}

function LedgerUnavailable() {
  return <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">O livro financeiro ainda não está instalado ou você não possui acesso aos valores. A aba Vendas continua disponível e nenhum pagamento será importado automaticamente.</div>;
}

function FieldLabel({ children }: { children: ReactNode }) {
  return <label className="block space-y-1.5 text-sm font-medium text-slate-200">{children}</label>;
}

function CategoryManagement({ organizationId, categories }: { organizationId: string; categories: Category[] }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4"><h3 className="font-semibold">Categorias cadastradas</h3>{categories.length===0 ? <p className="mt-2 text-sm text-amber-200">Nenhuma categoria cadastrada.</p> : <div className="mt-3 space-y-4">{categories.map((category) => <details key={category.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3"><summary className="cursor-pointer"><span className="font-medium">{category.name}</span><span className="ml-2 text-xs text-slate-400">{category.entry_kind === "revenue" ? "Receita" : category.entry_kind === "expense" ? "Despesa" : "Receita e despesa"}{category.is_active ? "" : " · Inativa"}</span></summary><p className="mt-2 break-all font-mono text-xs text-slate-500">{category.id}</p><div className="mt-3 grid gap-3 lg:grid-cols-2"><FinancialActionForm action={upsertFinancialCategoryAction} submitLabel="Salvar alterações" idempotencyScope={`edit-category:${category.id}`}><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="categoryId" value={category.id}/><FieldLabel>Nome<input className={field} name="name" required defaultValue={category.name}/></FieldLabel><FieldLabel>Aplicação<select className={field} name="entryKind" defaultValue={category.entry_kind}><option value="revenue">Somente receitas</option><option value="expense">Somente despesas</option><option value="both">Receitas e despesas</option></select></FieldLabel><FieldLabel>Situação<select className={field} name="isActive" defaultValue={String(category.is_active)}><option value="true">Ativa</option><option value="false">Inativa</option></select></FieldLabel></FinancialActionForm><FinancialActionForm action={removeFinancialCategoryAction} submitLabel="Excluir categoria" idempotencyScope={`remove-category:${category.id}`} tone="danger"><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="categoryId" value={category.id}/><p className="text-sm text-slate-400">Se já houver lançamentos, a categoria será desativada para preservar o histórico.</p><FieldLabel>Motivo<input className={field} name="reason" required placeholder="Explique a correção"/></FieldLabel></FinancialActionForm></div></details>)}</div>}</div>;
}

function SupplierManagement({ organizationId, suppliers }: { organizationId: string; suppliers: Supplier[] }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-950/30 p-4"><h3 className="font-semibold">Fornecedores cadastrados</h3>{suppliers.length===0 ? <p className="mt-2 text-sm text-amber-200">Nenhum fornecedor cadastrado.</p> : <div className="mt-3 space-y-4">{suppliers.map((supplier) => <details key={supplier.id} className="rounded-lg border border-slate-800 bg-slate-900/70 p-3"><summary className="cursor-pointer"><span className="font-medium">{supplier.display_name || supplier.legal_name}</span>{supplier.is_active ? null : <span className="ml-2 text-xs text-slate-400">Inativo</span>}</summary><p className="mt-2 break-all font-mono text-xs text-slate-500">{supplier.id}</p><div className="mt-3 grid gap-3 lg:grid-cols-2"><FinancialActionForm action={upsertFinancialSupplierAction} submitLabel="Salvar alterações" idempotencyScope={`edit-supplier:${supplier.id}`}><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="supplierId" value={supplier.id}/><FieldLabel>Razão social ou nome<input className={field} name="legalName" required defaultValue={supplier.legal_name}/></FieldLabel><FieldLabel>Nome fantasia<input className={field} name="displayName" defaultValue={supplier.display_name ?? ""}/></FieldLabel><FieldLabel>Situação<select className={field} name="isActive" defaultValue={String(supplier.is_active)}><option value="true">Ativo</option><option value="false">Inativo</option></select></FieldLabel></FinancialActionForm><FinancialActionForm action={removeFinancialSupplierAction} submitLabel="Excluir fornecedor" idempotencyScope={`remove-supplier:${supplier.id}`} tone="danger"><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="supplierId" value={supplier.id}/><p className="text-sm text-slate-400">Se já houver lançamentos, o fornecedor será desativado.</p><FieldLabel>Motivo<input className={field} name="reason" required/></FieldLabel></FinancialActionForm></div></details>)}</div>}</div>;
}

function SettingsPanel({ organizationId, accounts, categories, suppliers, events, simpleAvailable }: { organizationId: string; accounts: Account[]; categories: Category[]; suppliers: Supplier[]; events: { id: unknown; name: unknown }[]; simpleAvailable: boolean }) {
  const systemReady = ['SYS_CAIXA','SYS_RECEITAS','SYS_DESPESAS','SYS_A_PAGAR'].every((code) => accounts.some((account) => account.code === code && account.is_active));
  return <SectionCard title="Configurações financeiras" description="Categorias e fornecedores. Dados bancários não são necessários para o gateway.">
    <div className="mb-5 rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4">
      <h3 className="font-semibold text-emerald-200">Preparação simples</h3>
      <p className="mt-1 text-sm text-slate-300">O Militrin usa contas técnicas internas. Você não precisa informar banco, agência ou número de conta.</p>
      {!simpleAvailable ? <p className="mt-2 text-sm text-amber-200">A migration 112 precisa ser aplicada antes de habilitar despesas e contas pagas.</p> : systemReady ? <p className="mt-2 text-sm text-emerald-200">Configuração interna pronta.</p> : <div className="mt-3"><FinancialActionForm action={initializeSimpleFinanceAction} submitLabel="Preparar financeiro" idempotencyScope="simple-finance"><input type="hidden" name="organizationId" value={organizationId}/></FinancialActionForm></div>}
    </div>
    <div className="grid gap-4 xl:grid-cols-2">
      <FinancialActionForm action={upsertFinancialCategoryAction} submitLabel="Criar categoria" idempotencyScope="financial-category">
        <div><h3 className="font-semibold">Categorias</h3><p className="mt-1 text-sm text-slate-400">Exemplos: Inscrições, Camisetas, Estrutura e Alimentação.</p></div>
        <input type="hidden" name="organizationId" value={organizationId}/>
        <FieldLabel>Nome da categoria<input className={field} name="name" required placeholder="Ex.: Inscrições"/></FieldLabel>
        <FieldLabel>Aplicação<select className={field} name="entryKind" defaultValue="revenue"><option value="revenue">Somente receitas</option><option value="expense">Somente despesas</option><option value="both">Receitas e despesas</option></select></FieldLabel>
      </FinancialActionForm>
      <FinancialActionForm action={upsertFinancialSupplierAction} submitLabel="Criar fornecedor" idempotencyScope="financial-supplier"><div><h3 className="font-semibold">Fornecedores</h3><p className="mt-1 text-sm text-slate-400">Opcional no cadastro de despesas.</p></div><input type="hidden" name="organizationId" value={organizationId}/><FieldLabel>Razão social ou nome<input className={field} name="legalName" required/></FieldLabel><FieldLabel>Nome fantasia<input className={field} name="displayName"/></FieldLabel><FieldLabel>CPF/CNPJ<input className={field} name="taxIdentifier"/></FieldLabel></FinancialActionForm>
    </div>
    <div className="mt-5 grid gap-4 xl:grid-cols-2"><CategoryManagement organizationId={organizationId} categories={categories}/><SupplierManagement organizationId={organizationId} suppliers={suppliers}/></div>
    <div className="mt-5 rounded-xl border border-slate-800 p-4"><h3 className="font-semibold">Centros de custo por evento</h3><p className="mt-1 text-sm text-slate-400">Já disponíveis automaticamente; não é necessário cadastrá-los novamente.</p>{events.map((event) => <p key={String(event.id)} className="mt-2 text-sm">{String(event.name)} · <span className="break-all font-mono text-xs">{String(event.id)}</span></p>)}</div>
  </SectionCard>;
}

function validDate(value: string | undefined) { return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : ""; }
function parseComparisonPeriod(value: string) {
  const match=value.match(/^(\*|\d{4}-\d{2}-\d{2})\.\.(\*|\d{4}-\d{2}-\d{2})$/); if(!match) return null;
  const from=match[1]==="*" ? "" : match[1]; const to=match[2]==="*" ? "" : match[2];
  const format=(date:string) => date ? date.split("-").reverse().join("/") : "sem limite";
  return { key:value, from, to, label:from||to ? `${format(from)} a ${format(to)}` : "Todo o período" };
}

export default async function FinanceiroPage({ searchParams }: { searchParams: Promise<{ tab?: string; status?: string; eventId?: string; dateFrom?: string; dateTo?: string; compareEvent?: string | string[]; comparePeriod?: string | string[]; viewEvent?: string | string[]; compareRow?: string | string[] }> }) {
  const params = await searchParams;
  const active = tabs.some(([code]) => code === params.tab) ? params.tab as Tab : "overview";
  const status = params.status && (statusOptions as readonly string[]).includes(params.status) ? params.status : "pending";
  const dateFrom = validDate(params.dateFrom);
  const dateTo = validDate(params.dateTo);
  const sales = active === "sales" ? await loadSales(status, params.eventId ?? null) : null;
  const ledger = active !== "sales" ? await loadLedger(active === "overview" ? null : params.eventId ?? null, active === "overview") : null;
  const context = sales ?? ledger!;
  const organizationId = context.organizationId ?? "";
  const eventOptions = context.events.map((event) => ({ id: String(event.id), name: String(event.name), is_active: Boolean(event.is_active) }));
  const requestedViewIds=(Array.isArray(params.viewEvent)?params.viewEvent:params.viewEvent?[params.viewEvent]:[]).filter((id)=>eventOptions.some((event)=>event.id===id));
  const viewEventIds=[...new Set(requestedViewIds)];
  const rawComparisonRows=Array.isArray(params.compareRow)?params.compareRow:params.compareRow?[params.compareRow]:[];
  const comparisonSpecs=[...new Set(rawComparisonRows)].flatMap((key)=>{const separator=key.indexOf("|");if(separator<1)return[];const eventIds=[...new Set(key.slice(0,separator).split(","))].filter((id)=>eventOptions.some((event)=>event.id===id));const period=parseComparisonPeriod(key.slice(separator+1));return period&&eventIds.length>0?[{key,eventIds,period}]:[];});
  const comparisonIds=[...new Set(comparisonSpecs.flatMap((item)=>item.eventIds))];
  const viewLabel=viewEventIds.length===0?"Todos os eventos":viewEventIds.length===1?eventOptions.find((event)=>event.id===viewEventIds[0])?.name??"Evento selecionado":`${viewEventIds.length} eventos selecionados`;
  const viewRepresentative=context.events.find((event)=>String(event.id)===viewEventIds[0]);
  if(active==="overview"&&viewRepresentative)context.selected={...viewRepresentative,name:viewLabel};
  const selectedEventId=active==="overview"?(viewEventIds[0]??""):context.selected?String(context.selected.id):"";

  return <main className="min-h-screen bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row"><Sidebar/><div className="min-w-0 flex-1 space-y-6">
    <TopBar title="Financeiro" subtitle="Vendas e livro financeiro administrativo"/><Tabs active={active} eventId={selectedEventId} status={status}/>
    {active === "overview" ? <FinancialOverviewControls events={eventOptions} selectedIds={viewEventIds} dateFrom={dateFrom} dateTo={dateTo}/> : <EventContextSelector events={eventOptions} selectedEventId={selectedEventId || null} pathname="/financeiro"/>}
    {active === "sales" && sales ? <SectionCard title="Vendas" description="Listagem existente de pagamentos; não cria lançamentos no livro."><div className="mb-4 flex flex-wrap gap-2">{statusOptions.map((option) => <Link key={option} href={`/financeiro?tab=sales&status=${option}${selectedEventId ? `&eventId=${selectedEventId}` : ""}`} className={`rounded-lg border px-3 py-2 text-sm ${status === option ? "border-emerald-400 text-emerald-200" : "border-slate-700"}`}>{statusLabels[option]}</Link>)}</div><div className="overflow-x-auto rounded-xl border border-slate-800"><table className="min-w-full text-sm"><thead className="bg-slate-950 text-left text-slate-400"><tr><th className="p-3">Nome</th><th className="p-3">CPF</th><th className="p-3">Valor</th><th className="p-3">Forma</th><th className="p-3">Status</th><th className="p-3">Criado</th><th className="p-3">Pago</th></tr></thead><tbody>{(sales.rows as PaymentRow[]).map((row) => { const participant = Array.isArray(row.participants) ? row.participants[0] : row.participants; return <tr key={row.id} className="border-t border-slate-800"><td className="p-3">{participant?.full_name ?? "—"}</td><td className="p-3">{participant?.cpf ?? "—"}</td><td className="p-3">R$ {Number(row.final_amount).toFixed(2)}</td><td className="p-3">{row.payment_method}</td><td className="p-3">{row.payment_status === "paid" ? "Confirmado" : row.payment_status === "pending" ? "Pendente" : row.payment_status === "expired" ? "Expirado" : "Cancelado"}</td><td className="p-3">{formatDateTimeBR(row.created_at, " às ")}</td><td className="p-3">{row.paid_at ? formatDateTimeBR(row.paid_at, " às ") : "—"}</td></tr>; })}</tbody></table></div></SectionCard> : null}
    {active !== "sales" && active !== "overview" && !selectedEventId ? <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-100">Selecione um evento para usar esta operação.</div> : null}
    {active !== "sales" && ledger && !ledger.available ? <LedgerUnavailable/> : null}
    {ledger?.available && organizationId && (selectedEventId || active === "overview") ? (() => {
      const inRange = (value: string | null, from: string, to: string) => Boolean(value) && (!from || value!.slice(0,10) >= from) && (!to || value!.slice(0, 10) <= to);
      const inPeriod = (value: string | null) => inRange(value,dateFrom,dateTo);
      const summaryEntryIds = new Set((ledger.allocations as Allocation[]).filter((allocation) => viewEventIds.length===0 || viewEventIds.includes(allocation.event_id)).map((allocation) => allocation.entry_id));
      const allPeriodEntries = ledger.entries.filter((entry) => inPeriod(entry.occurred_on));
      const periodEntries = allPeriodEntries.filter((entry) => summaryEntryIds.has(entry.id));
      const revenues = periodEntries.filter((entry) => entry.entry_kind === "revenue");
      const expenses = ledger.entries.filter((entry) => summaryEntryIds.has(entry.id) && entry.entry_kind === "expense");
      const allPeriodSettlements = ledger.settlements.filter((settlement) => inPeriod(settlement.paid_on));
      const allPeriodReversals = ledger.reversals.filter((reversal) => inPeriod(reversal.created_at));
      const periodSettlements = allPeriodSettlements.filter((settlement) => summaryEntryIds.has(settlement.expense_entry_id));
      const periodReversals = allPeriodReversals.filter((reversal) => summaryEntryIds.has(reversal.original_entry_id));
      const paidByExpense = new Map<string, number>();
      for (const settlement of ledger.settlements) paidByExpense.set(settlement.expense_entry_id, (paidByExpense.get(settlement.expense_entry_id) ?? 0) + Number(settlement.amount));
      const grossRevenue = revenues.reduce((sum, entry) => sum + Number(entry.amount), 0);
      const refunds = periodReversals.reduce((sum, reversal) => sum + Number(reversal.amount), 0);
      const paidExpenses = periodSettlements.reduce((sum, settlement) => sum + Number(settlement.amount), 0);
      const periodTicketMetrics = (ledger.ticketMetrics as TicketMetric[]).filter((item) => inPeriod(item.issuedAt) && (viewEventIds.length===0 || viewEventIds.includes(item.eventId)));
      const soldTickets = periodTicketMetrics.filter((item) => item.kind === "sold").length;
      const courtesyTickets = periodTicketMetrics.filter((item) => item.kind === "courtesy").length;
      const totalExpenses = expenses.reduce((sum, entry) => sum + Number(entry.amount), 0);
      const allPaidExpenses = [...paidByExpense.values()].reduce((sum, amount) => sum + amount, 0);
      const payable = Math.max(0, totalExpenses - allPaidExpenses);
      const money = (value: number) => value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
      const entryById = new Map(ledger.entries.map((entry) => [entry.id, entry]));
      const comparison = comparisonSpecs.flatMap((spec) => {
        const events=context.events.filter((item)=>spec.eventIds.includes(String(item.id))); if(events.length===0)return[];
        const eventIds = spec.eventIds; const comparisonPeriod=spec.period;
        const allocations = (ledger.allocations as Allocation[]).filter((allocation) => eventIds.includes(allocation.event_id));
        const ids = new Set(allocations.map((allocation) => allocation.entry_id));
        const comparisonEntryIds=new Set(ledger.entries.filter((entry) => inRange(entry.occurred_on,comparisonPeriod.from,comparisonPeriod.to)).map((entry) => entry.id));
        const eventRevenue = allocations.filter((allocation) => comparisonEntryIds.has(allocation.entry_id) && entryById.get(allocation.entry_id)?.entry_kind === "revenue").reduce((sum, allocation) => sum + Number(allocation.amount), 0);
        const eventExpenseAllocations = allocations.filter((allocation) => comparisonEntryIds.has(allocation.entry_id) && entryById.get(allocation.entry_id)?.entry_kind === "expense");
        const eventExpenseIds=new Set(eventExpenseAllocations.map((allocation) => allocation.entry_id));
        const eventExpenseTotal = eventExpenseAllocations.reduce((sum, allocation) => sum + Number(allocation.amount), 0);
        const eventRefunds = ledger.reversals.filter((reversal) => ids.has(reversal.original_entry_id) && inRange(reversal.created_at,comparisonPeriod.from,comparisonPeriod.to)).reduce((sum, reversal) => sum + Number(reversal.amount), 0);
        const eventPaid = ledger.settlements.filter((settlement) => ids.has(settlement.expense_entry_id) && inRange(settlement.paid_on,comparisonPeriod.from,comparisonPeriod.to)).reduce((sum, settlement) => sum + Number(settlement.amount), 0);
        const eventAllPaid = ledger.settlements.filter((settlement) => eventExpenseIds.has(settlement.expense_entry_id)).reduce((sum, settlement) => sum + Number(settlement.amount), 0);
        const eventTickets=(ledger.ticketMetrics as TicketMetric[]).filter((item) => eventIds.includes(item.eventId) && inRange(item.issuedAt,comparisonPeriod.from,comparisonPeriod.to));
        const eventNames=events.map((event)=>String(event.name));
        const label=`${eventNames.join(" + ")} — ${comparisonPeriod.label}`;
        return [{ id: spec.key, eventIds, name: <ComparisonRowLabel label={label} rowKey={spec.key}/>, period:comparisonPeriod.label, dateFrom:comparisonPeriod.from, dateTo:comparisonPeriod.to, revenue: eventRevenue, refunds: eventRefunds, paid: eventPaid, payable: Math.max(0, eventExpenseTotal - eventAllPaid), result: eventRevenue - eventRefunds - eventPaid, sold: eventTickets.filter((item) => item.kind==="sold").length, courtesy: eventTickets.filter((item) => item.kind==="courtesy").length }];
      });
      const periodLabel = dateFrom || dateTo ? `${dateFrom ? dateFrom.split("-").reverse().join("/") : "início"} a ${dateTo ? dateTo.split("-").reverse().join("/") : "hoje"}` : "todo o período";
      return <>
        {active === "overview" ? <SectionCard title="Visão geral" description={`${selectedEventId ? `Totais de ${context.selected?.name}` : "Total geral de todos os eventos"} · ${periodLabel}.`}><FinancialOverviewFilters dateFrom={dateFrom} dateTo={dateTo}/><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
          ["Ingressos vendidos",soldTickets,"count"],["Cortesias",courtesyTickets,"count"],["Receita bruta",grossRevenue,"money"],["Estornos",refunds,"money"],["Receita líquida",grossRevenue-refunds,"money"],["Despesas pagas",paidExpenses,"money"],["Contas a pagar",payable,"money"],["Resultado líquido",grossRevenue-refunds-paidExpenses,"money"],
        ].map(([label,value,format]) => <div key={String(label)} className="rounded-xl border border-slate-800 bg-slate-900 p-4"><p className="text-sm text-slate-400">{label}</p><p className="mt-1 text-xl font-semibold">{format === "count" ? Number(value).toLocaleString("pt-BR") : money(Number(value))}</p></div>)}</div><div className="mt-6"><h3 className="font-semibold">Comparativo entre eventos</h3><p className="mt-1 text-sm text-slate-400">Use o mesmo período para comparar edições, como Militrin 2026 e 2027.</p><div className="mt-4"><ComparisonEventSelector events={eventOptions} selectedIds={comparisonIds}/></div><div className="overflow-x-auto rounded-xl border border-slate-800"><table className="min-w-full text-sm"><thead className="bg-slate-950 text-left text-slate-400"><tr><th className="p-3">Evento</th><th className="p-3">Vendidos</th><th className="p-3">Cortesias</th><th className="p-3">Receita</th><th className="p-3">Estornos</th><th className="p-3">Despesas pagas</th><th className="p-3">A pagar</th><th className="p-3">Resultado</th></tr></thead><tbody>{comparison.map((row) => <tr key={row.id} className="border-t border-slate-800"><td className="p-3 font-medium">{row.name}</td><td className="p-3">{row.sold.toLocaleString("pt-BR")}</td><td className="p-3">{row.courtesy.toLocaleString("pt-BR")}</td><td className="p-3">{money(row.revenue)}</td><td className="p-3">{money(row.refunds)}</td><td className="p-3">{money(row.paid)}</td><td className="p-3">{money(row.payable)}</td><td className="p-3 font-semibold">{money(row.result)}</td></tr>)}</tbody></table></div></div></SectionCard> : null}
        {active === "expenses" ? <SectionCard title="Nova despesa" description="Cadastre uma conta a pagar. Depois, marque o pagamento na aba Contas a pagar.">{!ledger.simpleAvailable ? <LedgerUnavailable/> : <FinancialActionForm action={createSimpleFinancialExpenseAction} submitLabel="Cadastrar despesa" idempotencyScope="simple-expense"><input type="hidden" name="organizationId" value={organizationId}/><input type="hidden" name="eventId" value={selectedEventId}/><FieldLabel>Descrição<input className={field} name="description" required placeholder="Ex.: Locação de estrutura"/></FieldLabel><div className="grid gap-3 sm:grid-cols-2"><FieldLabel>Valor<input className={field} name="amount" required inputMode="decimal" placeholder="0,00"/></FieldLabel><FieldLabel>Vencimento<input className={field} name="dueDate" required type="date"/></FieldLabel><FieldLabel>Data da despesa<input className={field} name="occurredOn" type="date"/></FieldLabel><FieldLabel>Categoria<select className={field} name="categoryId"><option value="">Sem categoria</option>{ledger.categories.filter((category) => category.entry_kind === "expense" || category.entry_kind === "both").map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></FieldLabel><FieldLabel>Fornecedor<select className={field} name="supplierId"><option value="">Sem fornecedor</option>{ledger.suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.display_name || supplier.legal_name}</option>)}</select></FieldLabel></div></FinancialActionForm>}</SectionCard> : null}
        {active === "payable" ? <SectionCard title="Contas a pagar" description="Despesas pendentes ou parcialmente pagas."><div className="space-y-3">{expenses.filter((entry) => Number(entry.amount) > (paidByExpense.get(entry.id) ?? 0)).map((entry) => { const balance=Number(entry.amount)-(paidByExpense.get(entry.id)??0); return <div key={entry.id} className="rounded-xl border border-slate-800 p-4"><div className="flex flex-wrap justify-between gap-2"><div><p className="font-semibold">{entry.description}</p><p className="text-sm text-slate-400">Vencimento: {entry.due_date ?? "Não informado"}</p></div><p className="font-semibold text-amber-200">{money(balance)}</p></div>{ledger.simpleAvailable ? <div className="mt-3"><FinancialActionForm action={settleSimpleFinancialExpenseAction} submitLabel="Marcar como paga" idempotencyScope={`settle-expense:${entry.id}`}><input type="hidden" name="entryId" value={entry.id}/><div className="grid gap-3 sm:grid-cols-3"><FieldLabel>Valor pago<input className={field} name="amount" required defaultValue={balance.toFixed(2)}/></FieldLabel><FieldLabel>Data do pagamento<input className={field} name="paidOn" required type="date"/></FieldLabel><FieldLabel>Motivo ou referência<input className={field} name="reason" required placeholder="Pagamento confirmado"/></FieldLabel></div></FinancialActionForm></div> : null}</div>; })}{expenses.length===0 ? <p className="text-sm text-slate-400">Nenhuma conta a pagar cadastrada.</p> : null}</div></SectionCard> : null}
        {active === "paid" ? <SectionCard title="Contas pagas" description="Histórico de baixas confirmadas."><div className="space-y-3">{ledger.settlements.map((settlement) => { const expense=expenses.find((entry) => entry.id===settlement.expense_entry_id); return <div key={settlement.id} className="rounded-xl border border-slate-800 p-4"><p className="font-semibold">{expense?.description ?? "Despesa"}</p><p className="mt-1 text-sm text-slate-300">{money(Number(settlement.amount))} · Pago em {settlement.paid_on}</p>{settlement.reason ? <p className="text-sm text-slate-400">{settlement.reason}</p> : null}</div>; })}{ledger.settlements.length===0 ? <p className="text-sm text-slate-400">Nenhuma conta paga registrada.</p> : null}</div></SectionCard> : null}
        {active === "refunds" ? <SectionCard title="Estornos" description="Registra o estorno financeiro. Não realiza reembolso automático no gateway."><div className="space-y-3">{revenues.filter((entry) => entry.lifecycle_status!=="reversed").map((entry) => { const reversed=ledger.reversals.filter((item) => item.original_entry_id===entry.id).reduce((sum,item)=>sum+Number(item.amount),0); const balance=Number(entry.amount)-reversed; return <div key={entry.id} className="rounded-xl border border-slate-800 p-4"><div className="flex justify-between gap-3"><p className="font-semibold">{entry.description}</p><p>{money(balance)} disponível</p></div><div className="mt-3"><FinancialActionForm action={reverseFinancialEntryAction} submitLabel="Registrar estorno" idempotencyScope={`refund:${entry.id}`}><input type="hidden" name="entryId" value={entry.id}/><div className="grid gap-3 sm:grid-cols-2"><FieldLabel>Valor do estorno<input className={field} name="amount" required defaultValue={balance.toFixed(2)}/></FieldLabel><FieldLabel>Motivo<input className={field} name="reason" required/></FieldLabel></div></FinancialActionForm></div></div>; })}{revenues.length===0 ? <p className="text-sm text-slate-400">Nenhuma receita disponível para estorno.</p> : null}</div></SectionCard> : null}
        {active === "settings" ? <SettingsPanel organizationId={organizationId} accounts={ledger.accounts} categories={ledger.categories} suppliers={ledger.suppliers} events={context.events} simpleAvailable={ledger.simpleAvailable}/> : null}
      </>;
    })() : null}
  </div></div></main>;
}
