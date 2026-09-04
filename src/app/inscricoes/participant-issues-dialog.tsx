"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { BirthDateInput } from "@/components/forms/BirthDateInput";
import { formatCpf, formatPhone, isValidCpf } from "@/lib/validation/registration";
import { isValidDateBR, parseDateBRToISO } from "@/lib/utils/date";
import { getParticipantIssueOptionsAction, resolveMyParticipantDataIssuesAction, resolveParticipantDataIssuesAction } from "./actions";

export type ParticipantDataIssue = {
  id: string; field_code: string; issue_type: string; message: string;
  import_batch_id?: string | null;
  blocks_payment: boolean; blocks_ticket_issuance: boolean; blocks_checkin: boolean; blocks_kit_delivery: boolean;
};

type Option = { id: string; name: string };
type Price = { batch_id: string; ticket_category_id: string; male_price: number | null; female_price: number | null };
type Props = {
  participantId: string; participantName: string; issues: ParticipantDataIssue[]; canEdit: boolean;
  shirtOptions?: Array<{ type: string; sizes: string[] }>;
  triggerLabel?: string;
  mode?: "admin" | "self";
  expectedIssueIds?: string[];
  relatedImportBatchId?: string;
  onResolved?: (result: { ticketId: string | null; finalization: string | null; message: string }) => void | Promise<void>;
};

function deduplicateIssues(issues: ParticipantDataIssue[]) {
  const unique = new Map<string, ParticipantDataIssue>();
  for (const issue of issues) {
    const key = `${issue.field_code}:${issue.issue_type}`;
    const previous = unique.get(key);
    unique.set(key, previous ? {
      ...previous,
      blocks_payment: previous.blocks_payment || issue.blocks_payment,
      blocks_ticket_issuance: previous.blocks_ticket_issuance || issue.blocks_ticket_issuance,
      blocks_checkin: previous.blocks_checkin || issue.blocks_checkin,
      blocks_kit_delivery: previous.blocks_kit_delivery || issue.blocks_kit_delivery,
    } : issue);
  }
  return Array.from(unique.values());
}

function impactLabels(issue: ParticipantDataIssue) {
  return [issue.blocks_payment ? "Bloqueia pagamento" : null, issue.blocks_ticket_issuance ? "Bloqueia ingresso" : null,
    issue.blocks_checkin ? "Bloqueia check-in" : null, issue.blocks_kit_delivery ? "Bloqueia item/kit" : null].filter(Boolean) as string[];
}

export function ParticipantIssuesDialog({ participantId, participantName, issues: initialIssues, canEdit, shirtOptions = [], triggerLabel = "Dados pendentes", mode = "admin", expectedIssueIds, relatedImportBatchId, onResolved }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [issues, setIssues] = useState(initialIssues);
  const [values, setValues] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [validation, setValidation] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState<Option[]>([]);
  const [batches, setBatches] = useState<Option[]>([]);
  const [prices, setPrices] = useState<Price[]>([]);
  const [loadedShirts, setLoadedShirts] = useState(shirtOptions);
  const [isPending, startTransition] = useTransition();
  const visibleIssues = useMemo(() => deduplicateIssues(issues), [issues]);
  const sourceImportBatchId = relatedImportBatchId ?? issues.find((issue) => issue.import_batch_id)?.import_batch_id ?? undefined;
  const selectedCategory = values.category ?? "";
  const selectedBatch = values.batch ?? "";
  const compatiblePrices = useMemo(() => prices.filter((price) => (!selectedCategory || price.ticket_category_id === selectedCategory) && (!selectedBatch || price.batch_id === selectedBatch)), [prices, selectedCategory, selectedBatch]);
  const availableCategories = selectedBatch ? categories.filter((category) => prices.some((price) => price.batch_id === selectedBatch && price.ticket_category_id === category.id)) : categories;
  const availableBatches = selectedCategory ? batches.filter((batch) => prices.some((price) => price.ticket_category_id === selectedCategory && price.batch_id === batch.id)) : batches;
  const selectedShirtType = values.shirt_type ?? "";
  const availableSizes = loadedShirts.find((option) => option.type === selectedShirtType)?.sizes ?? [];

  function updateValue(field: string, value: string) {
    setValues((current) => ({ ...current, [field]: value }));
    setValidation((current) => ({ ...current, [field]: "" }));
  }

  function openResolver() {
    setOpen(true); setMessage(null);
    startTransition(async () => {
      const result = await getParticipantIssueOptionsAction(participantId);
      if (!result.success) { setMessage(result.message); return; }
      setCategories(result.categories.map((item) => ({ id: String(item.id), name: String(item.name) })));
      setBatches(result.batches.map((item) => ({ id: String(item.id), name: String(item.name) })));
      setPrices(result.prices.map((item) => ({ batch_id: String(item.batch_id), ticket_category_id: String(item.ticket_category_id), male_price: item.male_price === null ? null : Number(item.male_price), female_price: item.female_price === null ? null : Number(item.female_price) })));
      if (result.shirts.length) setLoadedShirts(result.shirts);
      setValues((current) => ({ ...current,
        ...(visibleIssues.some((issue) => issue.field_code === "category") && result.currentCategoryId ? { category: result.currentCategoryId } : {}),
        ...(visibleIssues.some((issue) => issue.field_code === "batch") && result.currentBatchId ? { batch: result.currentBatchId } : {}),
      }));
    });
  }

  function submit() {
    const errors: Record<string, string> = {};
    if (values.cpf && !isValidCpf(values.cpf)) errors.cpf = "Informe um CPF válido.";
    if (values.birth_date && !isValidDateBR(values.birth_date)) errors.birth_date = "Informe uma data válida no formato dd/MM/aaaa.";
    if (values.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) errors.email = "Informe um e-mail válido.";
    setValidation(errors);
    if (Object.keys(errors).length) return;
    const payload = { ...values };
    if (payload.birth_date) payload.birth_date = parseDateBRToISO(payload.birth_date) ?? "";
    setMessage(null);
    startTransition(async () => {
      const result = await (mode === "self" ? resolveMyParticipantDataIssuesAction : resolveParticipantDataIssuesAction)({ participantId, expectedIssueIds: expectedIssueIds ?? issues.map((issue) => issue.id), values: payload });
      setMessage(result.message);
      if (!result.success) return;
      const remaining = (result.remainingIssues ?? []) as ParticipantDataIssue[];
      setIssues(mode === "self" ? [] : remaining); setValues({}); router.refresh();
      await onResolved?.({ ticketId: result.ticketId ?? null, finalization: result.finalization ?? null, message: result.message });
    });
  }

  const inputClass = "h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3";
  const triggerClass = "inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200";
  if (!canEdit) return <span className={triggerClass}>Dados pendentes</span>;

  return <><button type="button" onClick={openResolver} className={`${triggerClass} hover:bg-amber-500/20`}>{triggerLabel}</button>{open ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4" role="dialog" aria-modal="true"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-700 bg-slate-900 shadow-2xl">
    <div className="border-b border-slate-800 px-6 py-5"><h2 className="text-xl font-semibold">Resolver pendências</h2><p className="mt-1 text-sm text-slate-300">{participantName} · preencha todas e salve uma única vez</p></div>
    <div className="space-y-4 px-6 py-5">
      {visibleIssues.map((issue) => <div key={`${issue.field_code}:${issue.issue_type}`} className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4"><p className="text-sm font-medium text-amber-100">{issue.message}</p><div className="mt-2 flex flex-wrap gap-1.5">{impactLabels(issue).map((impact) => <span key={impact} className="rounded-full bg-slate-800 px-2 py-1 text-[10px]">{impact}</span>)}</div><div className="mt-3">
        {issue.field_code === "gender" ? <label className="space-y-1 text-sm"><span>Gênero</span><select value={values.gender ?? ""} onChange={(event) => updateValue("gender", event.target.value)} className={inputClass}><option value="">Selecione</option><option value="male">Masculino</option><option value="female">Feminino</option></select></label> : null}
        {issue.field_code === "birth_date" ? <BirthDateInput name={`birth-${participantId}`} value={values.birth_date ?? ""} onChange={(value) => updateValue("birth_date", value)} error={validation.birth_date} /> : null}
        {issue.field_code === "cpf" ? <label className="space-y-1 text-sm"><span>CPF</span><input inputMode="numeric" value={values.cpf ?? ""} onChange={(event) => updateValue("cpf", formatCpf(event.target.value))} className={inputClass}/>{validation.cpf ? <span className="text-xs text-rose-300">{validation.cpf}</span> : null}</label> : null}
        {issue.field_code === "email" ? <label className="space-y-1 text-sm"><span>E-mail</span><input type="email" value={values.email ?? ""} onChange={(event) => updateValue("email", event.target.value)} className={inputClass}/>{validation.email ? <span className="text-xs text-rose-300">{validation.email}</span> : null}</label> : null}
        {issue.field_code === "phone" ? <label className="space-y-1 text-sm"><span>Telefone</span><input type="tel" inputMode="tel" value={values.phone ?? ""} onChange={(event) => updateValue("phone", formatPhone(event.target.value))} className={inputClass}/></label> : null}
        {issue.field_code === "city" ? <label className="space-y-1 text-sm"><span>Cidade</span><input value={values.city ?? ""} onChange={(event) => updateValue("city", event.target.value)} className={inputClass}/></label> : null}
        {issue.field_code === "category" ? <label className="space-y-1 text-sm"><span>Categoria do ingresso</span><select value={selectedCategory} onChange={(event) => updateValue("category", event.target.value)} className={inputClass}><option value="">Selecione</option>{availableCategories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
        {issue.field_code === "batch" ? <label className="space-y-1 text-sm"><span>Lote</span><select value={selectedBatch} onChange={(event) => updateValue("batch", event.target.value)} className={inputClass}><option value="">Selecione</option>{availableBatches.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : null}
        {["shirt_type","shirt_size","shirt_selection"].includes(issue.field_code) ? <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1 text-sm"><span>Tipo de camiseta</span><select value={selectedShirtType} onChange={(event) => { updateValue("shirt_type", event.target.value); updateValue("shirt_size", ""); }} className={inputClass}><option value="">Selecione</option>{loadedShirts.map((item) => <option key={item.type} value={item.type}>{item.type}</option>)}</select></label><label className="space-y-1 text-sm"><span>Tamanho</span><select value={values.shirt_size ?? ""} onChange={(event) => updateValue("shirt_size", event.target.value)} disabled={!selectedShirtType} className={inputClass}><option value="">Selecione</option>{availableSizes.map((size) => <option key={size}>{size}</option>)}</select></label></div> : null}
        {issue.field_code === "price" ? <p className="text-xs text-slate-300">O valor será recalculado ao selecionar gênero, categoria e lote válidos.{compatiblePrices.length === 1 ? ` Faixa encontrada: masculino R$ ${Number(compatiblePrices[0].male_price ?? 0).toFixed(2)} / feminino R$ ${Number(compatiblePrices[0].female_price ?? 0).toFixed(2)}.` : ""}</p> : null}
        {issue.field_code === "event_date" ? <p className="text-xs text-slate-300">A data do evento precisa ser configurada no painel do evento; ela não pertence ao cadastro pessoal.</p> : null}
      </div></div>)}
      {visibleIssues.length === 0 ? <div className="rounded-2xl bg-emerald-500/10 p-4 text-emerald-200">Todas as pendências foram resolvidas.</div> : null}
      {mode === "admin" && sourceImportBatchId && visibleIssues.some((issue) => ["category","batch","price"].includes(issue.field_code)) ? <Link href={`/cadastros?import_batch_id=${encodeURIComponent(sourceImportBatchId)}`} onClick={() => setOpen(false)} className="inline-flex rounded-xl border border-amber-500/40 px-3 py-2 text-sm text-amber-200">Ver demais pessoas deste lote</Link> : null}
      {message ? <p className="rounded-xl bg-slate-950 p-3 text-sm text-slate-300">{message}</p> : null}
    </div><div className="flex justify-end gap-2 border-t border-slate-800 px-6 py-4"><button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-4 py-2 text-sm">Fechar</button><button type="button" onClick={submit} disabled={isPending || !visibleIssues.length || !Object.keys(values).length} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-50">{isPending ? "Reavaliando..." : "Salvar e reavaliar"}</button></div>
  </div></div> : null}</>;
}
