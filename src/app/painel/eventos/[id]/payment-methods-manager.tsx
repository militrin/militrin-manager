"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { upsertEventPaymentMethodsAction } from "@/app/eventos/actions";

type FeeMode = "absorb" | "pass_through" | "split";

type InstallmentFee = { installments: number; fixed_fee: number; percentage_fee: number };

type EventPaymentMethodsManagerProps = {
  eventId: string;
  initialConfig: {
    pix_enabled: boolean;
    credit_card_single_enabled: boolean;
    credit_card_installments_enabled: boolean;
    pix_fee_mode: FeeMode;
    pix_fee_fixed_amount: number;
    pix_fee_percentage: number;
    pix_customer_fee_share_percent: number;
    credit_card_single_fee_mode: FeeMode;
    credit_card_single_fee_fixed_amount: number;
    credit_card_single_fee_percentage: number;
    credit_card_single_customer_fee_share_percent: number;
    credit_card_installments_fee_mode: FeeMode;
    credit_card_installments_customer_fee_share_percent: number;
    installment_fees: InstallmentFee[];
  };
};

const MAX_INSTALLMENTS = 12;

function emptyInstallmentSchedule(): InstallmentFee[] {
  return Array.from({ length: MAX_INSTALLMENTS }, (_, index) => ({ installments: index + 1, fixed_fee: 0, percentage_fee: 0 }));
}

function mergeInstallmentSchedule(saved: InstallmentFee[]): InstallmentFee[] {
  const byCount = new Map(saved.map((row) => [row.installments, row]));
  return emptyInstallmentSchedule().map((row) => byCount.get(row.installments) ?? row);
}

type FeeModeState = { fee_mode: FeeMode; customer_fee_share_percent: number };

/** Bloco reutilizavel "Tratamento da taxa" (Absorver/Repassar/Dividir) --
 * usado pelos 3 metodos (PIX, cartao a vista, cartao parcelado). Cartao
 * parcelado nao passa fixedAmount/percentage/onFixedChange/onPercentageChange
 * (esses valores variam por parcela, editados na tabela abaixo). */
function FeeModeFields({
  title,
  state,
  onModeChange,
  onShareChange,
  fixedAmount,
  percentage,
  onFixedChange,
  onPercentageChange,
}: {
  title: string;
  state: FeeModeState;
  onModeChange: (mode: FeeMode) => void;
  onShareChange: (value: number) => void;
  fixedAmount?: number;
  percentage?: number;
  onFixedChange?: (value: number) => void;
  onPercentageChange?: (value: number) => void;
}) {
  const showFixedPercentage = fixedAmount !== undefined && percentage !== undefined;

  return (
    <div className="mt-3 space-y-2 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Tratamento da taxa -- {title}</p>

      <div className="space-y-1.5 text-sm text-slate-200">
        <label className="flex items-center gap-2">
          <input type="radio" checked={state.fee_mode === "absorb"} onChange={() => onModeChange("absorb")} />
          Absorver (organizador assume 100% da taxa)
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={state.fee_mode === "pass_through"} onChange={() => onModeChange("pass_through")} />
          Repassar integralmente ao comprador
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={state.fee_mode === "split"} onChange={() => onModeChange("split")} />
          Dividir entre organizador e comprador
        </label>
      </div>

      {state.fee_mode === "split" ? (
        <div className="ml-6 flex items-center gap-2 text-sm text-slate-200">
          <span>Percentual pago pelo cliente:</span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={state.customer_fee_share_percent}
            onChange={(event) => onShareChange(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
            className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right"
          />
          <span>%</span>
          <span className="text-xs text-slate-500">(organizador absorve {(100 - state.customer_fee_share_percent).toFixed(2)}%)</span>
        </div>
      ) : null}

      {showFixedPercentage ? (
        <div className="flex flex-wrap items-center gap-4 text-sm text-slate-200">
          <label className="flex items-center gap-2">
            Taxa fixa: R$
            <input
              type="number"
              min={0}
              step={0.01}
              value={fixedAmount}
              onChange={(event) => onFixedChange?.(Math.max(0, Number(event.target.value) || 0))}
              className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right"
            />
          </label>
          <label className="flex items-center gap-2">
            Taxa percentual:
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={percentage}
              onChange={(event) => onPercentageChange?.(Math.min(100, Math.max(0, Number(event.target.value) || 0)))}
              className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right"
            />
            %
          </label>
        </div>
      ) : null}
    </div>
  );
}

export function EventPaymentMethodsManager({ eventId, initialConfig }: EventPaymentMethodsManagerProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [form, setForm] = useState({
    pix_enabled: initialConfig.pix_enabled,
    credit_card_single_enabled: initialConfig.credit_card_single_enabled,
    credit_card_installments_enabled: initialConfig.credit_card_installments_enabled,
    pix_fee_mode: initialConfig.pix_fee_mode,
    pix_fee_fixed_amount: initialConfig.pix_fee_fixed_amount,
    pix_fee_percentage: initialConfig.pix_fee_percentage,
    pix_customer_fee_share_percent: initialConfig.pix_customer_fee_share_percent,
    credit_card_single_fee_mode: initialConfig.credit_card_single_fee_mode,
    credit_card_single_fee_fixed_amount: initialConfig.credit_card_single_fee_fixed_amount,
    credit_card_single_fee_percentage: initialConfig.credit_card_single_fee_percentage,
    credit_card_single_customer_fee_share_percent: initialConfig.credit_card_single_customer_fee_share_percent,
    credit_card_installments_fee_mode: initialConfig.credit_card_installments_fee_mode,
    credit_card_installments_customer_fee_share_percent: initialConfig.credit_card_installments_customer_fee_share_percent,
  });
  const [installmentFees, setInstallmentFees] = useState<InstallmentFee[]>(mergeInstallmentSchedule(initialConfig.installment_fees));

  function updateInstallmentFee(installments: number, patch: Partial<InstallmentFee>) {
    setInstallmentFees((prev) => prev.map((row) => (row.installments === installments ? { ...row, ...patch } : row)));
  }

  function save() {
    setMessage(null);

    if (!form.pix_enabled && !form.credit_card_single_enabled && !form.credit_card_installments_enabled) {
      setMessage({ type: "error", text: "Selecione pelo menos uma forma de pagamento." });
      return;
    }

    startTransition(async () => {
      const result = await upsertEventPaymentMethodsAction({
        event_id: eventId,
        ...form,
        // So envia linhas de parcela com alguma taxa configurada -- parcela
        // sem taxa nao precisa virar linha no banco (fixed/percentage=0 e o
        // mesmo resultado de "sem linha", ja garantido pelo default da RPC).
        installment_fees: installmentFees.filter((row) => row.fixed_fee > 0 || row.percentage_fee > 0),
      });

      if (!result.success) {
        setMessage({ type: "error", text: result.message });
        return;
      }

      router.push(`/painel/eventos/${eventId}?etapa=6`);
    });
  }

  return (
    <div className="space-y-4">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
          {message.text}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-100">Formas aceitas neste evento</p>
        <p className="mt-1 text-xs text-slate-400">
          Essas opcoes controlam o checkout do participante. Mostraremos apenas as formas habilitadas abaixo. Por padrao a taxa de pagamento e absorvida pelo organizador -- ative &quot;Repassar&quot; ou &quot;Dividir&quot; para cobrar (parte d)ela do comprador.
        </p>

        <div className="mt-4 space-y-4 text-sm text-slate-200">
          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.pix_enabled}
                onChange={(event) => setForm((prev) => ({ ...prev, pix_enabled: event.target.checked }))}
              />
              PIX
            </label>
            {form.pix_enabled ? (
              <FeeModeFields
                title="PIX"
                state={{ fee_mode: form.pix_fee_mode, customer_fee_share_percent: form.pix_customer_fee_share_percent }}
                onModeChange={(mode) => setForm((prev) => ({ ...prev, pix_fee_mode: mode }))}
                onShareChange={(value) => setForm((prev) => ({ ...prev, pix_customer_fee_share_percent: value }))}
                fixedAmount={form.pix_fee_fixed_amount}
                percentage={form.pix_fee_percentage}
                onFixedChange={(value) => setForm((prev) => ({ ...prev, pix_fee_fixed_amount: value }))}
                onPercentageChange={(value) => setForm((prev) => ({ ...prev, pix_fee_percentage: value }))}
              />
            ) : null}
          </div>

          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.credit_card_single_enabled}
                onChange={(event) => setForm((prev) => ({ ...prev, credit_card_single_enabled: event.target.checked }))}
              />
              Credito a vista
            </label>
            {form.credit_card_single_enabled ? (
              <FeeModeFields
                title="Credito a vista"
                state={{ fee_mode: form.credit_card_single_fee_mode, customer_fee_share_percent: form.credit_card_single_customer_fee_share_percent }}
                onModeChange={(mode) => setForm((prev) => ({ ...prev, credit_card_single_fee_mode: mode }))}
                onShareChange={(value) => setForm((prev) => ({ ...prev, credit_card_single_customer_fee_share_percent: value }))}
                fixedAmount={form.credit_card_single_fee_fixed_amount}
                percentage={form.credit_card_single_fee_percentage}
                onFixedChange={(value) => setForm((prev) => ({ ...prev, credit_card_single_fee_fixed_amount: value }))}
                onPercentageChange={(value) => setForm((prev) => ({ ...prev, credit_card_single_fee_percentage: value }))}
              />
            ) : null}
          </div>

          <div>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.credit_card_installments_enabled}
                onChange={(event) => setForm((prev) => ({ ...prev, credit_card_installments_enabled: event.target.checked }))}
              />
              Credito parcelado
            </label>
            {form.credit_card_installments_enabled ? (
              <>
                <FeeModeFields
                  title="Credito parcelado"
                  state={{ fee_mode: form.credit_card_installments_fee_mode, customer_fee_share_percent: form.credit_card_installments_customer_fee_share_percent }}
                  onModeChange={(mode) => setForm((prev) => ({ ...prev, credit_card_installments_fee_mode: mode }))}
                  onShareChange={(value) => setForm((prev) => ({ ...prev, credit_card_installments_customer_fee_share_percent: value }))}
                />
                <div className="mt-3 overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Taxa por numero de parcelas</p>
                  <table className="w-full min-w-[420px] text-sm text-slate-200">
                    <thead>
                      <tr className="text-left text-xs text-slate-500">
                        <th className="pb-1 pr-2">Parcelas</th>
                        <th className="pb-1 pr-2">Taxa fixa (R$)</th>
                        <th className="pb-1">Taxa percentual (%)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {installmentFees.map((row) => (
                        <tr key={row.installments}>
                          <td className="py-1 pr-2">{row.installments}x</td>
                          <td className="py-1 pr-2">
                            <input
                              type="number"
                              min={0}
                              step={0.01}
                              value={row.fixed_fee}
                              onChange={(event) => updateInstallmentFee(row.installments, { fixed_fee: Math.max(0, Number(event.target.value) || 0) })}
                              className="w-24 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right"
                            />
                          </td>
                          <td className="py-1">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              step={0.01}
                              value={row.percentage_fee}
                              onChange={(event) => updateInstallmentFee(row.installments, { percentage_fee: Math.min(100, Math.max(0, Number(event.target.value) || 0)) })}
                              className="w-20 rounded-lg border border-slate-700 bg-slate-950 px-2 py-1 text-right"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-2 text-xs text-slate-500">Parcela sem taxa fixa nem percentual preenchidas nao cobra taxa adicional. Valores de exemplo -- ajuste conforme a taxa real negociada com o gateway.</p>
                </div>
              </>
            ) : null}
          </div>
        </div>

        <button
          type="button"
          onClick={save}
          disabled={isPending}
          className="mt-4 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60"
        >
          {isPending ? "Salvando..." : "Salvar e ir para próxima etapa"}
        </button>
      </div>
    </div>
  );
}
