"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { SHIRT_SIZES, SHIRT_TYPES } from "@/lib/constants/shirts";
import { createClient } from "@/lib/supabase/client";
import { updateParticipantWithStock } from "./actions";

const paymentMethods = ["Pix", "Dinheiro", "Cartão", "Transferência"];
const paymentStatuses = ["pending", "paid", "refunded"];

export default function EditParticipantPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const [participant, setParticipant] = useState<{
    id: string;
    full_name: string;
    birth_date: string | null;
    phone: string | null;
    email: string | null;
    city: string | null;
    gender: string | null;
    shirt_type: string | null;
    shirt_size: string | null;
    notes: string | null;
    amount: number | null;
    payment_method: string | null;
    payment_status: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      const { id } = await params;
      const supabase = createClient();
      const { data, error } = await supabase.from("participants").select("*").eq("id", id).single();
      if (!error) setParticipant(data);
      setLoading(false);
    }
    load();
  }, [params]);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const { id } = await params;
    setSaving(true);
    setMessage(null);

    const payload = {
      full_name: form.get("full_name")?.toString() ?? "",
      birth_date: form.get("birth_date")?.toString() ?? null,
      phone: form.get("phone")?.toString() ?? "",
      email: form.get("email")?.toString() ?? null,
      city: form.get("city")?.toString() ?? null,
      gender: form.get("gender")?.toString() ?? null,
      shirt_type: form.get("shirt_type")?.toString() ?? "",
      shirt_size: form.get("shirt_size")?.toString() ?? "",
      notes: form.get("notes")?.toString() ?? null,
      amount: Number(form.get("amount") ?? 0),
      payment_method: form.get("payment_method")?.toString() ?? null,
      payment_status: form.get("payment_status")?.toString() ?? "pending",
    };

    try {
      await updateParticipantWithStock({
        id,
        full_name: payload.full_name,
        birth_date: payload.birth_date,
        phone: payload.phone,
        email: payload.email,
        city: payload.city,
        gender: payload.gender,
        shirt_type: payload.shirt_type,
        shirt_size: payload.shirt_size,
        notes: payload.notes,
        amount: payload.amount,
        payment_method: payload.payment_method,
        payment_status: payload.payment_status,
      });
      setMessage("Dados atualizados com sucesso.");
      setSaving(false);
      router.push(`/inscricoes/${id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Não foi possível atualizar o inscrito.");
      setSaving(false);
    }
  }

  if (loading || !participant) return <div className="p-8 text-slate-200">Carregando...</div>;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />
        <div className="flex-1 space-y-6">
          <TopBar title="Editar inscrito" subtitle="Atualize os dados e o pagamento" />
          <SectionCard title="Dados do participante" description="Edite os dados e o status de pagamento.">
            <form onSubmit={onSubmit} className="space-y-5">
              {message ? <div className="rounded-2xl bg-slate-950/70 p-3 text-sm text-slate-300">{message}</div> : null}
              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm"><span className="text-slate-300">Nome</span><input defaultValue={participant.full_name} name="full_name" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Data de nascimento</span><input type="date" defaultValue={participant.birth_date ?? ""} name="birth_date" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Telefone</span><input defaultValue={participant.phone ?? ""} name="phone" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">E-mail</span><input defaultValue={participant.email ?? ""} name="email" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Cidade</span><input defaultValue={participant.city ?? ""} name="city" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Sexo</span><input defaultValue={participant.gender ?? ""} name="gender" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Modelo</span><select defaultValue={participant.shirt_type ?? "Camiseta"} name="shirt_type" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3"><option value="">Selecione</option>{SHIRT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Tamanho</span><select defaultValue={participant.shirt_size ?? ""} name="shirt_size" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">{SHIRT_SIZES[participant.shirt_type as keyof typeof SHIRT_SIZES]?.map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Valor</span><input defaultValue={participant.amount ?? ""} name="amount" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Forma de pagamento</span><select defaultValue={participant.payment_method ?? ""} name="payment_method" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">{paymentMethods.map((method) => <option key={method} value={method}>{method}</option>)}</select></label>
                <label className="space-y-2 text-sm"><span className="text-slate-300">Status do pagamento</span><select defaultValue={participant.payment_status ?? "pending"} name="payment_status" className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3">{paymentStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></label>
              </div>
              <label className="block space-y-2 text-sm"><span className="text-slate-300">Observações</span><textarea defaultValue={participant.notes ?? ""} name="notes" rows={4} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3" /></label>
              <div className="flex justify-end"><button type="submit" disabled={saving} className="rounded-2xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">{saving ? "Salvando..." : "Salvar alterações"}</button></div>
            </form>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
