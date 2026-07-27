"use client";

import { useMemo, useState, useTransition } from "react";
import { createCouponAction, toggleCouponAction, updateCouponAction } from "./actions";
import { formatDateBR, formatDateTimeBR, toDatetimeLocalValue } from "@/lib/utils/date";

type CouponRow = {
  id: string;
  event_id: string;
  code: string;
  coupon_type: "courtesy" | "percentage";
  discount_percent: number;
  max_uses: number | null;
  used_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

type CouponRedemptionRow = {
  id: string;
  coupon_id: string;
  participant_id: string;
  event_id: string;
  original_amount: number;
  discount_amount: number;
  final_amount: number;
  redeemed_at: string;
  participants?: { id?: string | null; full_name?: string | null; cpf?: string | null } | null;
};

type FormState = {
  id?: string;
  code: string;
  coupon_type: "courtesy" | "percentage";
  discount_percent: string;
  max_uses: string;
  valid_from: string;
  valid_until: string;
  notes: string;
  is_active: boolean;
};

function initialForm(): FormState {
  return {
    code: "",
    coupon_type: "courtesy",
    discount_percent: "100",
    max_uses: "",
    valid_from: "",
    valid_until: "",
    notes: "",
    is_active: true,
  };
}

function toDatetimeLocal(value: string | null) {
  return toDatetimeLocalValue(value);
}

export function CouponsManager({
  eventId,
  coupons,
  redemptions,
}: {
  eventId: string;
  coupons: CouponRow[];
  redemptions: CouponRedemptionRow[];
}) {
  const [isPending, startTransition] = useTransition();
  const [form, setForm] = useState<FormState>(initialForm());
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [historyCouponId, setHistoryCouponId] = useState<string | null>(null);

  const historyItems = useMemo(
    () => redemptions.filter((item) => item.coupon_id === historyCouponId),
    [redemptions, historyCouponId],
  );

  function resetForm() {
    setForm(initialForm());
  }

  function loadForEdit(coupon: CouponRow) {
    setForm({
      id: coupon.id,
      code: coupon.code,
      coupon_type: coupon.coupon_type,
      discount_percent: String(coupon.discount_percent),
      max_uses: coupon.max_uses == null ? "" : String(coupon.max_uses),
      valid_from: toDatetimeLocal(coupon.valid_from),
      valid_until: toDatetimeLocal(coupon.valid_until),
      notes: coupon.notes ?? "",
      is_active: coupon.is_active,
    });
  }

  function updateField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function submit() {
    setMessage(null);
    const discount = form.coupon_type === "courtesy" ? 100 : Number(form.discount_percent || 0);
    const payload = {
      id: form.id,
      event_id: eventId,
      code: form.code,
      coupon_type: form.coupon_type,
      discount_percent: discount,
      max_uses: form.max_uses ? Number(form.max_uses) : null,
      valid_from: form.valid_from || null,
      valid_until: form.valid_until || null,
      notes: form.notes || null,
      is_active: form.is_active,
    };

    startTransition(async () => {
      const result = form.id ? await updateCouponAction(payload) : await createCouponAction(payload);
      setMessage({ type: result.success ? "success" : "error", text: result.message });
      if (result.success) {
        resetForm();
      }
    });
  }

  function toggle(coupon: CouponRow) {
    setMessage(null);
    startTransition(async () => {
      const result = await toggleCouponAction({
        id: coupon.id,
        event_id: coupon.event_id,
        is_active: !coupon.is_active,
      });
      setMessage({ type: result.success ? "success" : "error", text: result.message });
    });
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{form.id ? "Editar cupom" : "Novo cupom"}</p>

        {message ? (
          <div
            className={`mt-3 rounded-xl border px-3 py-2 text-sm ${
              message.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : "border-red-500/30 bg-red-500/10 text-red-200"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Código</span>
            <input value={form.code} onChange={(e) => updateField("code", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Tipo</span>
            <select
              value={form.coupon_type}
              onChange={(e) => {
                const type = e.target.value as "courtesy" | "percentage";
                updateField("coupon_type", type);
                if (type === "courtesy") updateField("discount_percent", "100");
              }}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            >
              <option value="courtesy">Cortesia</option>
              <option value="percentage">Percentual</option>
            </select>
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Percentual</span>
            <input
              value={form.discount_percent}
              disabled={form.coupon_type === "courtesy"}
              onChange={(e) => updateField("discount_percent", e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 disabled:opacity-60"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Limite de usos</span>
            <input value={form.max_uses} onChange={(e) => updateField("max_uses", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Início</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.valid_from} onChange={(e) => updateField("valid_from", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Fim</span>
            <input type="datetime-local" lang="pt-BR" placeholder="dd/MM/aaaa HH:mm" value={form.valid_until} onChange={(e) => updateField("valid_until", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
          </label>
        </div>

        <label className="mt-3 block space-y-1 text-sm">
          <span className="text-slate-300">Observação</span>
          <input value={form.notes} onChange={(e) => updateField("notes", e.target.value)} className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2" />
        </label>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input type="checkbox" checked={form.is_active} onChange={(e) => updateField("is_active", e.target.checked)} />
          Ativo
        </label>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submit} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? "Salvando..." : form.id ? "Atualizar" : "Criar cupom"}
          </button>
          {form.id ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Cancelar edição
            </button>
          ) : null}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-800/80">
        <table className="min-w-full divide-y divide-slate-800 text-sm">
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              <th className="px-4 py-3">Código</th>
              <th className="px-4 py-3">Tipo</th>
              <th className="px-4 py-3">Desconto</th>
              <th className="px-4 py-3">Usos</th>
              <th className="px-4 py-3">Limite</th>
              <th className="px-4 py-3">Validade</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Ações</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
            {coupons.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-slate-400">Nenhum cupom criado para o evento ativo.</td>
              </tr>
            ) : (
              coupons.map((coupon) => (
                <tr key={coupon.id}>
                  <td className="px-4 py-3 font-semibold">{coupon.code}</td>
                  <td className="px-4 py-3">{coupon.coupon_type === "courtesy" ? "Cortesia" : "Percentual"}</td>
                  <td className="px-4 py-3">{Number(coupon.discount_percent).toFixed(2)}%</td>
                  <td className="px-4 py-3">{coupon.used_count}</td>
                  <td className="px-4 py-3">{coupon.max_uses ?? "Ilimitado"}</td>
                  <td className="px-4 py-3">
                    {coupon.valid_from ? formatDateBR(coupon.valid_from) : "-"}
                    {" -> "}
                    {coupon.valid_until ? formatDateBR(coupon.valid_until) : "-"}
                  </td>
                  <td className="px-4 py-3">{coupon.is_active ? "Ativo" : "Inativo"}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button type="button" onClick={() => loadForEdit(coupon)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Editar</button>
                      <button type="button" onClick={() => toggle(coupon)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">{coupon.is_active ? "Desativar" : "Ativar"}</button>
                      <button type="button" onClick={() => void navigator.clipboard.writeText(coupon.code)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Copiar código</button>
                      <button type="button" onClick={() => setHistoryCouponId(historyCouponId === coupon.id ? null : coupon.id)} className="rounded-lg border border-slate-700 px-2 py-1 text-xs">Utilizações</button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {historyCouponId ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <p className="text-sm font-semibold text-slate-200">Utilizações do cupom</p>
          <div className="mt-3 space-y-2">
            {historyItems.length === 0 ? (
              <p className="text-sm text-slate-400">Sem utilizações registradas.</p>
            ) : (
              historyItems.map((item) => (
                <div key={item.id} className="grid gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm md:grid-cols-6">
                  <span>{formatDateTimeBR(item.redeemed_at, " às ")}</span>
                  <span>{item.participants?.id ?? item.participant_id}</span>
                  <span>{item.participants?.full_name ?? "Participante"}</span>
                  <span>{item.participants?.cpf ?? "CPF não informado"}</span>
                  <span>R$ {Number(item.discount_amount).toFixed(2)}</span>
                  <span>Final: R$ {Number(item.final_amount).toFixed(2)}</span>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
