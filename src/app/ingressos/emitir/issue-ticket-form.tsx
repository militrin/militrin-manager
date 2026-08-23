"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { getEventCategoriesAndBatchesAction } from "@/app/operacoes/actions";
import { getEventShirtOptionsAction, issueTicketAction, lookupRegistrationContactAction, type IssueTicketReason } from "./actions";

type Option = { id: string; name: string };
type ShirtOption = { type: string; sizes: string[] };
type ContactLookup = { status: "idle" | "loading" | "found" | "error"; name?: string; message?: string };
type InitialContact = { id: string; name: string; pin: string };

const inputClass = "w-full rounded-xl border border-slate-800 bg-slate-950 p-3";
const pinPattern = /^[A-Z0-9]{10}$/i;

export function IssueTicketForm({ events, initialPin, initialContact }: { events: Option[]; initialPin: string; initialContact: InitialContact | null }) {
  const [pin, setPin] = useState(initialPin);
  const [registrationContactId, setRegistrationContactId] = useState<string | null>(initialContact?.id ?? null);
  const [eventId, setEventId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [batchId, setBatchId] = useState("");
  const [categories, setCategories] = useState<Option[]>([]);
  const [batches, setBatches] = useState<Option[]>([]);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [reason, setReason] = useState<IssueTicketReason>("courtesy");
  const [quantity, setQuantity] = useState("1");
  const [pricingGender, setPricingGender] = useState("Masculino");
  const [shirtType, setShirtType] = useState("");
  const [shirtSize, setShirtSize] = useState("");
  const [shirtOptions, setShirtOptions] = useState<ShirtOption[]>([]);
  const [hasShirts, setHasShirts] = useState(false);
  const [limitToStock, setLimitToStock] = useState(false);
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ success: boolean; message: string; ticketIds?: string[]; requiresHolderDecision?: boolean } | null>(null);
  const [contactLookup, setContactLookup] = useState<ContactLookup>(initialContact ? { status: "found", name: initialContact.name } : { status: "idle" });

  useEffect(() => {
    const trimmed = pin.trim();
    if (registrationContactId || !pinPattern.test(trimmed)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setContactLookup({ status: "loading" });
        const response = await lookupRegistrationContactAction(trimmed);
        if (cancelled) return;
        if (response.success) setRegistrationContactId(response.id);
        setContactLookup(response.success ? { status: "found", name: response.name } : { status: "error", message: response.message });
      })();
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [pin, registrationContactId]);

  useEffect(() => {
    if (!eventId) return;
    let cancelled = false;
    void (async () => {
      setLoadingOptions(true);
      const [categoriesResponse, shirtResponse] = await Promise.all([
        getEventCategoriesAndBatchesAction(eventId),
        getEventShirtOptionsAction(eventId),
      ]);
      if (cancelled) return;
      if (categoriesResponse.success) {
        setCategories(categoriesResponse.categories);
        setBatches(categoriesResponse.batches);
      } else {
        setResult({ success: false, message: categoriesResponse.message });
      }
      if (shirtResponse.success) {
        setHasShirts(shirtResponse.hasShirts);
        setLimitToStock(shirtResponse.limitToStock);
        setShirtOptions(shirtResponse.options);
      } else {
        setResult({ success: false, message: shirtResponse.message });
      }
      setLoadingOptions(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const notesRequired = reason === "other";
  const shirtSizesForType = shirtOptions.find((option) => option.type === shirtType)?.sizes ?? [];
  const hasCategories = categories.length > 0;
  const canSubmit = contactLookup.status === "found" && eventId && (!hasCategories || categoryId) && batchId && (!notesRequired || notes.trim()) && (!hasShirts || (shirtType && shirtSize));

  function submit(assignHolder = true) {
    setResult(null);
    if (!canSubmit) return;
    startTransition(async () => {
      const response = await issueTicketAction({
        pin: pin.trim(),
        registrationContactId,
        eventId,
        categoryId: hasCategories ? categoryId : null,
        batchId,
        quantity: Number(quantity) || 1,
        reason,
        pricingGender,
        shirtType,
        shirtSize,
        notes,
        assignHolder,
      });
      setResult(response);
    });
  }

  return (
    <div className="grid gap-4">
      {registrationContactId && contactLookup.status === "found" ? <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-100"><span className="text-emerald-300">Emitindo para:</span> <strong>{contactLookup.name}</strong></div> : null}
      {result ? (
        <div className={`rounded-xl border p-3 text-sm ${result.success ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`} role="status">
          <p>{result.message}</p>
          {result.success && result.ticketIds?.length ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {result.ticketIds.map((ticketId) => (
                <Link key={ticketId} href={registrationContactId ? `/ingressos/${ticketId}?from=cadastro&contactId=${encodeURIComponent(registrationContactId)}` : `/ingressos/${ticketId}`} className="text-xs underline">
                  Ver ingresso {ticketId.slice(0, 8)}
                </Link>
              ))}
              {registrationContactId ? <Link href={`/cadastros/${registrationContactId}`} className="text-xs font-semibold underline">Voltar para {contactLookup.name}</Link> : null}
            </div>
          ) : null}
          {!result.success && result.requiresHolderDecision ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" disabled={pending} onClick={() => submit(false)} className="rounded-lg bg-amber-300 px-3 py-2 font-semibold text-slate-950">
                Emitir sem titular
              </button>
              <button type="button" disabled={pending} onClick={() => setResult(null)} className="rounded-lg border border-slate-700 px-3 py-2 text-slate-200">
                Cancelar
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2">
        <label className="space-y-2">
          <span>PIN do cadastro</span>
          <input
            value={pin}
            onChange={(e) => {
              const value = e.target.value;
              setPin(value);
              setRegistrationContactId(null);
              if (!pinPattern.test(value.trim())) setContactLookup({ status: "idle" });
            }}
            placeholder="Digite o PIN do cadastro"
            className={inputClass}
          />
          {contactLookup.status === "loading" ? <p className="text-sm text-slate-400">Buscando cadastro...</p> : null}
          {contactLookup.status === "found" ? <p className="text-sm text-emerald-300">{contactLookup.name}</p> : null}
          {contactLookup.status === "error" ? <p className="text-sm text-rose-300">{contactLookup.message}</p> : null}
          <Link href="/cadastros/novo" className="text-sm text-emerald-300">Criar novo cadastro</Link>
        </label>

        <label className="space-y-2">
          <span>Evento</span>
          <select
            value={eventId}
            onChange={(e) => {
              setEventId(e.target.value);
              setCategoryId("");
              setBatchId("");
              setCategories([]);
              setBatches([]);
              setShirtType("");
              setShirtSize("");
              setShirtOptions([]);
              setHasShirts(false);
              setLimitToStock(false);
            }}
            className={inputClass}
          >
            <option value="">Selecione</option>
            {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
          </select>
        </label>

        <label className="space-y-2">
          <span>Categoria</span>
          {eventId && !loadingOptions && !hasCategories ? (
            <div className={`${inputClass} text-slate-300`}>Ingresso único</div>
          ) : (
            <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!eventId || loadingOptions} className={inputClass}>
              <option value="">{loadingOptions ? "Carregando..." : eventId ? "Selecione" : "Escolha um evento primeiro"}</option>
              {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
            </select>
          )}
        </label>

        <label className="space-y-2">
          <span>Lote</span>
          <select value={batchId} onChange={(e) => setBatchId(e.target.value)} disabled={!eventId || loadingOptions} className={inputClass}>
            <option value="">{loadingOptions ? "Carregando..." : eventId ? "Selecione" : "Escolha um evento primeiro"}</option>
            {batches.map((batch) => <option key={batch.id} value={batch.id}>{batch.name}</option>)}
          </select>
        </label>

        <label className="space-y-2">
          <span>Motivo da emissão administrativa</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as IssueTicketReason)} className={inputClass}>
            <option value="courtesy">Cortesia</option>
            <option value="system_failure">Emissão por falha do sistema</option>
            <option value="administrative_correction">Correção administrativa</option>
            <option value="other">Outro motivo</option>
          </select>
        </label>

        <label className="space-y-2">
          <span>Quantidade</span>
          <input type="number" min="1" max="20" value={quantity} onChange={(e) => setQuantity(e.target.value)} className={inputClass} />
        </label>

        <label className="space-y-2">
          <span>Regra de preço</span>
          <select value={pricingGender} onChange={(e) => setPricingGender(e.target.value)} className={inputClass}>
            <option>Masculino</option>
            <option>Feminino</option>
          </select>
        </label>

        {hasShirts ? (
          <>
            <label className="space-y-2">
              <span>Modelo de camiseta{limitToStock ? "" : " (sob encomenda)"}</span>
              <select
                value={shirtType}
                onChange={(e) => {
                  setShirtType(e.target.value);
                  setShirtSize("");
                }}
                disabled={loadingOptions}
                className={inputClass}
              >
                <option value="">Selecione</option>
                {shirtOptions.map((option) => <option key={option.type} value={option.type}>{option.type}</option>)}
              </select>
            </label>

            <label className="space-y-2">
              <span>Tamanho</span>
              <select value={shirtSize} onChange={(e) => setShirtSize(e.target.value)} disabled={!shirtType} className={inputClass}>
                <option value="">{shirtType ? "Selecione" : "Escolha o modelo primeiro"}</option>
                {shirtSizesForType.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
            </label>
          </>
        ) : null}

        <label className="space-y-2 md:col-span-2">
          <span>Observações{notesRequired ? " (obrigatório para \"Outro motivo\")" : ""}</span>
          <textarea value={notes} onChange={(e) => setNotes(e.target.value)} className={inputClass} />
        </label>
      </div>

      <button type="button" disabled={!canSubmit || pending} onClick={() => submit()} className="w-fit rounded-xl bg-emerald-500 px-4 py-3 font-semibold text-emerald-950 disabled:opacity-50">
        {pending ? "Emitindo..." : "Emitir ingresso"}
      </button>
    </div>
  );
}
