"use client";

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, CheckCircle2, Loader2, Shirt } from "lucide-react";
import { useRouter } from "next/navigation";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { SHIRT_SIZES, SHIRT_TYPES } from "@/lib/constants/shirts";
import { createRegistrationAction } from "./actions";
import { formatCpf, formatPhone, registrationSchema, type RegistrationFormValues } from "@/lib/validation/registration";

const paymentMethods = ["Pix", "Dinheiro", "Cartão", "Transferência"];
const paymentStatuses = ["Pendente", "Confirmado", "Cancelado"];

export default function NewRegistrationPage() {
  const router = useRouter();
  const [submitState, setSubmitState] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    setValue,
    reset,
    formState: { errors },
  } = useForm<RegistrationFormValues>({
    resolver: zodResolver(registrationSchema),
    defaultValues: {
      full_name: "",
      cpf: "",
      birth_date: "",
      gender: "",
      phone: "",
      email: "",
      city: "",
      shirt_type: "Camiseta",
      shirt_size: "",
      payment_method: "",
      amount: "",
      payment_status: "Pendente",
      notes: "",
    },
  });

  const [shirtType, setShirtType] = useState<keyof typeof SHIRT_SIZES>("Camiseta");
  const availableSizes = SHIRT_SIZES[shirtType] ?? [];

  const onSubmit = async (data: RegistrationFormValues) => {
    setIsSubmitting(true);
    setSubmitState(null);

    const result = await createRegistrationAction(data);
    setIsSubmitting(false);

    if (!result?.success) {
      setSubmitState({ type: "error", message: result?.message ?? "Não foi possível concluir a inscrição." });
      return;
    }

    setSubmitState({ type: "success", message: result.message });
    reset();
    router.refresh();
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.18),_transparent_30%),linear-gradient(135deg,_#030712,_#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="flex-1 space-y-6">
          <TopBar title="Nova inscrição" subtitle="Cadastro de participante" />

          <SectionCard title="Dados do participante" description="Preencha os dados e salve a inscrição no Supabase.">
            <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
              {submitState ? (
                <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${submitState.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
                  {submitState.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                  <span>{submitState.message}</span>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Nome completo</span>
                  <input {...register("full_name")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                  {errors.full_name ? <p className="text-sm text-red-400">{errors.full_name.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">CPF</span>
                  <input
                    {...register("cpf")}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    maxLength={14}
                    onChange={(event) => setValue("cpf", formatCpf(event.target.value), { shouldValidate: true })}
                  />
                  {errors.cpf ? <p className="text-sm text-red-400">{errors.cpf.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Data de nascimento</span>
                  <input type="date" {...register("birth_date")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                  {errors.birth_date ? <p className="text-sm text-red-400">{errors.birth_date.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Sexo</span>
                  <select {...register("gender")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none">
                    <option value="">Selecione</option>
                    <option value="Masculino">Masculino</option>
                    <option value="Feminino">Feminino</option>
                    <option value="Outro">Outro</option>
                  </select>
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Telefone</span>
                  <input
                    {...register("phone")}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    maxLength={15}
                    onChange={(event) => setValue("phone", formatPhone(event.target.value), { shouldValidate: true })}
                  />
                  {errors.phone ? <p className="text-sm text-red-400">{errors.phone.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">E-mail</span>
                  <input type="email" {...register("email")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                  {errors.email ? <p className="text-sm text-red-400">{errors.email.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Cidade</span>
                  <input {...register("city")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Tipo de camiseta</span>
                  <select
                    {...register("shirt_type")}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    onChange={(event) => {
                      const nextType = event.target.value as keyof typeof SHIRT_SIZES;
                      setShirtType(nextType);
                      setValue("shirt_type", nextType, { shouldValidate: true });
                    }}
                  >
                    {SHIRT_TYPES.map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  {errors.shirt_type ? <p className="text-sm text-red-400">{errors.shirt_type.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Tamanho</span>
                  <select {...register("shirt_size")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none">
                    <option value="">Selecione</option>
                    {availableSizes.map((size) => (
                      <option key={size} value={size}>{size}</option>
                    ))}
                  </select>
                  {errors.shirt_size ? <p className="text-sm text-red-400">{errors.shirt_size.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Forma de pagamento</span>
                  <select {...register("payment_method")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none">
                    <option value="">Selecione</option>
                    {paymentMethods.map((method) => (
                      <option key={method} value={method}>{method}</option>
                    ))}
                  </select>
                  {errors.payment_method ? <p className="text-sm text-red-400">{errors.payment_method.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Valor</span>
                  <input {...register("amount")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" placeholder="R$ 120,00" />
                  {errors.amount ? <p className="text-sm text-red-400">{errors.amount.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Status do pagamento</span>
                  <select {...register("payment_status")} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none">
                    {paymentStatuses.map((status) => (
                      <option key={status} value={status}>{status}</option>
                    ))}
                  </select>
                  {errors.payment_status ? <p className="text-sm text-red-400">{errors.payment_status.message}</p> : null}
                </label>
              </div>

              <label className="block space-y-2 text-sm">
                <span className="text-slate-300">Observações</span>
                <textarea {...register("notes")} rows={4} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
              </label>

              <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <Shirt size={18} className="text-emerald-300" />
                  <span>Os tamanhos são validados com base no modelo selecionado.</span>
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-500 px-4 py-2.5 font-medium text-emerald-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-70"
                >
                  {isSubmitting ? <Loader2 size={18} className="animate-spin" /> : null}
                  {isSubmitting ? "Salvando..." : "Salvar inscrição"}
                </button>
              </div>
            </form>
          </SectionCard>
        </div>
      </div>
    </main>
  );
}
