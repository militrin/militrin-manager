"use client";

import { useState } from "react";
import Link from "next/link";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { AppBreadcrumb } from "@/components/navigation/AppBreadcrumb";
import { QrScanner } from "../components/QrScanner";
import { lookupWristbandByQrAction } from "../actions";

type LookupResult = Awaited<ReturnType<typeof lookupWristbandByQrAction>>;

function formatDateTime(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("pt-BR");
}

export function WristbandLookupClient() {
  const [result, setResult] = useState<LookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [scannerKey, setScannerKey] = useState(0);

  async function handleRead(value: string) {
    setLoading(true);
    try {
      const response = await lookupWristbandByQrAction(value);
      setResult(response);
    } catch (error) {
      setResult({ success: false, message: error instanceof Error ? error.message : "Falha inesperada." });
    } finally {
      setLoading(false);
    }
  }

  function handleScanAnother() {
    setResult(null);
    setScannerKey((key) => key + 1);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="min-w-0 flex-1 space-y-6">
          <header className="space-y-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 shadow-lg shadow-black/10">
            <AppBreadcrumb
              items={[{ label: "Início", href: "/painel" }, { label: "Central de Operações", href: "/operacoes" }, { label: "Ver pulseira vinculada" }]}
              backHref="/operacoes"
            />
            <div>
              <p className="text-sm font-medium uppercase tracking-[0.28em] text-emerald-400">Consulta rápida por QR</p>
              <h1 className="text-2xl font-semibold text-white">Ver pulseira vinculada</h1>
            </div>
          </header>

          <SectionCard
            title="Escaneie a pulseira"
            description="Aponte a câmera para o QR/código da pulseira para consultar o vínculo atual."
          >
            {!result ? (
              <QrScanner
                key={scannerKey}
                title="Escaneie a pulseira"
                onRead={handleRead}
                guideLabel="Posicione o QR da pulseira dentro da área"
                helpMessage="Aproxime a pulseira da câmera e evite reflexos."
              />
            ) : (
              <WristbandResultCard result={result} onScanAnother={handleScanAnother} />
            )}
            {loading ? <p className="mt-3 text-sm text-slate-400">Consultando...</p> : null}
          </SectionCard>
        </div>
      </div>
    </main>
  );
}

function WristbandResultCard({ result, onScanAnother }: { result: LookupResult; onScanAnother: () => void }) {
  return (
    <div className="rounded-3xl border border-slate-700 bg-slate-900 p-6">
      {/* QR invalido/nao reconhecido -- inclui, de proposito, codigo de
          outra organizacao (RLS ja filtra antes de chegar aqui, entao nunca
          da pra distinguir "nao existe" de "existe em outra org"). */}
      {!result.success ? (
        <div>
          <p className="text-lg font-bold text-rose-300">QR não reconhecido</p>
          <p className="mt-1 text-sm text-slate-400">{result.message}</p>
        </div>
      ) : null}

      {/* Pulseira com registro, mas o vinculo mais recente NAO esta ativo
          (desvinculada/substituida/bloqueada) -- nunca mostra dados de
          ingresso antigos como se ainda valessem. */}
      {result.success && result.state === "unlinked" ? (
        <div>
          <p className="text-lg font-bold text-amber-300">Pulseira não vinculada</p>
          <p className="mt-1 text-sm text-slate-400">Esta pulseira ainda não pertence a nenhum participante.</p>
          <div className="mt-4">
            <Field label="Código" value={result.wristband.code} />
          </div>
        </div>
      ) : null}

      {result.success && result.state === "linked" ? (
        <div className="space-y-4">
          <div>
            <p className="text-lg font-bold text-emerald-300">Pulseira vinculada</p>
            <p className="text-xs uppercase tracking-wide text-slate-500">Pulseira</p>
            <p className="text-2xl font-black">{result.wristband.code}</p>
            <p className="text-sm text-slate-400">
              Status: {result.wristband.status}
              {result.wristband.linked_at ? ` · vinculada em ${formatDateTime(result.wristband.linked_at)}` : ""}
            </p>
          </div>

          {result.ticket ? (
            <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
              <Field label="Comprador" value={result.ticket.buyer_name} />
              <Field label="Titular do ingresso" value={result.ticket.holder_name} />
              <Field label="Evento" value={result.ticket.event_name} />
              <Field label="Categoria" value={result.ticket.category_name} />
              <Field label="Status do ingresso" value={result.ticket.ticket_status} />
            </div>
          ) : (
            <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              Pulseira encontrada, mas você não tem permissão para ver os dados do ingresso vinculado.
            </p>
          )}
        </div>
      ) : null}

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onScanAnother}
          className="rounded-xl bg-cyan-500 px-4 py-2 text-sm font-semibold text-cyan-950"
        >
          Ler outra pulseira
        </button>
        <Link href="/operacoes" className="rounded-xl border border-slate-700 px-4 py-2 text-sm">
          Fechar / voltar
        </Link>
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="font-semibold text-slate-100">{value}</p>
    </div>
  );
}
