"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, CheckCircle2, Copy, Loader2, Shirt } from "lucide-react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { TopBar } from "@/components/dashboard/TopBar";
import { SectionCard } from "@/components/dashboard/SectionCard";
import { BirthDateInput } from "@/components/forms/BirthDateInput";
import { SHIRT_SIZES, SHIRT_TYPES } from "@/lib/constants/shirts";
import {
  cancelRegistrationPaymentAction,
  createRegistrationAction,
  generatePixPaymentAction,
  getParticipantPaymentAction,
  getPricingPreviewAction,
  getRegistrationFormContextAction,
  simulatePaymentAction,
  validateCouponAction,
} from "./actions";
import { formatCpf, formatPhone, registrationSchema, type RegistrationFormValues } from "@/lib/validation/registration";
import { formatDateTimeBR } from "@/lib/utils/date";
import { useSearchParams } from "next/navigation";

const paymentMethods = [
  { value: "pix", label: "PIX" },
  { value: "credit_card", label: "Cartão" },
  { value: "cash", label: "Dinheiro" },
  { value: "courtesy", label: "Cortesia" },
];

type PricingState = {
  batch_id: string;
  batch_name: string;
  sequence_number: number;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  remaining_slots: number;
  coupon_type: string | null;
  discount_percent: number;
};

type FormContextState = {
  active_event_id: string;
  active_event_name: string;
  kit_enabled: boolean;
  registration_enabled: boolean;
  has_shirt_item: boolean;
  batch_name: string;
  male_price: number;
  female_price: number;
  remaining_slots: number;
  inventory: Array<{
    shirt_type: string;
    shirt_size: string;
    available_quantity: number;
  }>;
  categories: Array<{
    id: string;
    name: string;
    slug: string;
    capacity: number | null;
    available_slots: number | null;
    is_active: boolean;
  }>;
  kit_items: Array<{
    id: string;
    name: string;
    slug: string;
    item_type: string;
    quantity_per_participant: number;
    requires_variant: boolean;
    is_required: boolean;
    is_active: boolean;
  }>;
};

type CreatedRegistrationState = {
  id: string;
  order_id: string;
  order_item_id: string;
  payment_id: string;
  ticket_id: string | null;
  full_name: string;
  event_name: string;
  batch_name: string;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  coupon_code: string | null;
  payment_status: string;
  reservation_expires_at: string | null;
  shirt_type: string;
  shirt_size: string;
};

type ParticipantPaymentState = {
  payment_id: string;
  amount: number;
  discount_amount: number;
  final_amount: number;
  payment_method: string | null;
  payment_status: string;
  pix_code: string | null;
  pix_qrcode: string | null;
  expires_at: string | null;
  paid_at: string | null;
};

function formatRemainingSeconds(ms: number) {
  if (ms <= 0) return "00:00:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export default function NewRegistrationPage() {
  const searchParams = useSearchParams();
  const selectedEventId = searchParams.get("eventId") ?? "";
  const [submitState, setSubmitState] = useState<{ type: "success" | "error"; message: string; issueWithoutHolderHref?: string } | null>(null);
  const [createdRegistration, setCreatedRegistration] = useState<CreatedRegistrationState | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isApplyingCoupon, setIsApplyingCoupon] = useState(false);
  const [isLoadingContext, setIsLoadingContext] = useState(true);
  const [formContext, setFormContext] = useState<FormContextState | null>(null);
  const [formUnavailableMessage, setFormUnavailableMessage] = useState<string | null>(null);
  const [isLoadingPricing, setIsLoadingPricing] = useState(false);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricing, setPricing] = useState<PricingState | null>(null);
  const [payment, setPayment] = useState<ParticipantPaymentState | null>(null);
  const [isGeneratingPix, setIsGeneratingPix] = useState(false);
  const [isSimulatingPix, setIsSimulatingPix] = useState(false);
  const [isSimulatingCard, setIsSimulatingCard] = useState(false);
  const [isCancellingPayment, setIsCancellingPayment] = useState(false);
  const [countdownTick, setCountdownTick] = useState(0);
  const [countdownNowMs, setCountdownNowMs] = useState(0);
  const [couponState, setCouponState] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const {
    register,
    control,
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
      has_shirt_item: false,
      ticket_category_id: "",
      payment_method: "",
      coupon_code: "",
      notes: "",
    },
  });

  const [shirtType, setShirtType] = useState<keyof typeof SHIRT_SIZES>("Camiseta");
  const availableSizes = SHIRT_SIZES[shirtType] ?? [];

  const genderValue = useWatch({ control, name: "gender" });
  const couponCode = useWatch({ control, name: "coupon_code" });
  const ticketCategoryId = useWatch({ control, name: "ticket_category_id" });
  const birthDateValue = useWatch({ control, name: "birth_date" });

  useEffect(() => {
    let mounted = true;

    const loadContext = async () => {
      setIsLoadingContext(true);
      const result = await getRegistrationFormContextAction(selectedEventId);

      if (!mounted) return;

      setIsLoadingContext(false);

      if (!result.success || !result.context) {
        setFormContext(null);
        setFormUnavailableMessage(result.message ?? "Inscrições indisponíveis no momento");
        return;
      }

      setFormUnavailableMessage(null);
      setFormContext(result.context);
      setValue("has_shirt_item", Boolean(result.context.has_shirt_item), { shouldValidate: false });

      if (!result.context.has_shirt_item) {
        setValue("shirt_type", "", { shouldValidate: false });
        setValue("shirt_size", "", { shouldValidate: false });
      } else {
        setValue("shirt_type", "Camiseta", { shouldValidate: false });
      }

      const defaultCategory = result.context.categories.find((category: FormContextState["categories"][number]) => category.slug === "open-bar") ?? result.context.categories[0];
      if (defaultCategory) {
        setValue("ticket_category_id", defaultCategory.id, { shouldValidate: true });
      }
    };

    void loadContext();

    return () => {
      mounted = false;
    };
  }, [setValue, selectedEventId]);

  useEffect(() => {
    if (!payment?.expires_at || payment.payment_status !== "pending") return;
    const first = window.setTimeout(() => setCountdownNowMs(Date.now()), 0);
    const timer = window.setInterval(() => {
      setCountdownTick((value) => value + 1);
      setCountdownNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [payment?.expires_at, payment?.payment_status]);

  const remainingTimeLabel = useMemo(() => {
    if (!payment?.expires_at || payment.payment_status !== "pending") return null;
    if (countdownNowMs <= 0) return null;
    const ms = new Date(payment.expires_at).getTime() - countdownNowMs;
    void countdownTick;
    return formatRemainingSeconds(ms);
  }, [payment?.expires_at, payment?.payment_status, countdownTick, countdownNowMs]);

  const refreshPricing = async (couponToApply?: string | null) => {
    if (!genderValue || !ticketCategoryId) {
      setPricing(null);
      setPricingError(null);
      return;
    }

    setIsLoadingPricing(true);
    setPricingError(null);

    const result = await getPricingPreviewAction({
      event_id: selectedEventId,
      gender: genderValue,
      ticket_category_id: ticketCategoryId,
      coupon_code: couponToApply?.trim() ? couponToApply : undefined,
    });

    setIsLoadingPricing(false);

    if (!result.success || !result.pricing) {
      setPricing(null);
      setPricingError(result.message ?? "Nao foi possivel calcular o preco.");
      return;
    }

    setPricing(result.pricing);
    setPricingError(null);
  };

  const applyCoupon = async () => {
    setIsApplyingCoupon(true);
    setCouponState(null);

    const result = await validateCouponAction({ event_id: selectedEventId, code: couponCode ?? "", gender: genderValue ?? "", ticket_category_id: ticketCategoryId ?? "" });
    setIsApplyingCoupon(false);

    if (!result.success || !result.pricing) {
      setCouponState({ type: "error", message: result.message });
      return;
    }

    setPricing(result.pricing);
    setCouponState({ type: "success", message: result.message });
  };

  const onSubmit = async (data: RegistrationFormValues) => {
    setIsSubmitting(true);
    setSubmitState(null);
    setCreatedRegistration(null);

    const result = await createRegistrationAction(selectedEventId, data);
    setIsSubmitting(false);

    if (!result?.success) {
      setSubmitState({
        type: "error",
        message: result?.message ?? "Não foi possível concluir a inscrição.",
        issueWithoutHolderHref: "issueWithoutHolderHref" in result ? result.issueWithoutHolderHref : undefined,
      });
      return;
    }

    setSubmitState({ type: "success", message: result.message });
    const created = result.registration ?? null;
    setCreatedRegistration(created);

    if (created?.id) {
      const paymentResult = await getParticipantPaymentAction(created.id);
      if (paymentResult.success && paymentResult.payment) {
        setPayment(paymentResult.payment);
      }
    }
  };

  const generatePix = async () => {
    if (!createdRegistration?.id) return;
    setIsGeneratingPix(true);
    setSubmitState(null);
    const result = await generatePixPaymentAction(createdRegistration.id);
    setIsGeneratingPix(false);
    if (!result.success) {
      setSubmitState({ type: "error", message: result.message ?? "Não foi possível gerar PIX." });
      return;
    }
    setPayment(result.payment ?? null);
    setSubmitState({ type: "success", message: result.message ?? "Pagamento confirmado com sucesso." });
  };

  const simulatePixPayment = async () => {
    if (!createdRegistration?.id) return;
    setIsSimulatingPix(true);
    setSubmitState(null);
    const result = await simulatePaymentAction(createdRegistration.id, "pix");
    setIsSimulatingPix(false);
    if (!result.success) {
      setSubmitState({ type: "error", message: result.message ?? "Não foi possível simular pagamento PIX." });
      return;
    }
    setPayment(result.payment ?? null);
    setSubmitState({ type: "success", message: result.message ?? "Pagamento confirmado com sucesso." });
  };

  const simulateCardPayment = async () => {
    if (!createdRegistration?.id) return;
    setIsSimulatingCard(true);
    setSubmitState(null);
    const result = await simulatePaymentAction(createdRegistration.id, "credit_card");
    setIsSimulatingCard(false);
    if (!result.success) {
      setSubmitState({ type: "error", message: result.message ?? "Não foi possível simular pagamento no cartão." });
      return;
    }
    setPayment(result.payment ?? null);
    setSubmitState({ type: "success", message: result.message ?? "Pagamento confirmado com sucesso." });
  };

  const cancelPayment = async () => {
    if (!createdRegistration?.id) return;
    setIsCancellingPayment(true);
    setSubmitState(null);
    const result = await cancelRegistrationPaymentAction(createdRegistration.id);
    setIsCancellingPayment(false);
    if (!result.success) {
      setSubmitState({ type: "error", message: result.message ?? "Não foi possível cancelar pagamento." });
      return;
    }
    setPayment(result.payment ?? null);
    setSubmitState({ type: "success", message: result.message ?? "Pagamento cancelado com sucesso." });
  };

  const copyPixCode = async () => {
    if (!payment?.pix_code) return;
    try {
      await navigator.clipboard.writeText(payment.pix_code);
      setSubmitState({ type: "success", message: "Código PIX copiado para a área de transferência." });
    } catch {
      setSubmitState({ type: "error", message: "Não foi possível copiar o código PIX." });
    }
  };

  const stockByTypeAndSize = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of formContext?.inventory ?? []) {
      map.set(`${item.shirt_type}::${item.shirt_size}`, Number(item.available_quantity));
    }
    return map;
  }, [formContext]);

  const getAvailableForSize = (type: string, size: string) => {
    return stockByTypeAndSize.get(`${type}::${size}`) ?? 0;
  };

  const activeCategories = useMemo(
    () => (formContext?.categories ?? []).filter((category) => category.is_active),
    [formContext?.categories],
  );

  const resetForNewRegistration = () => {
    reset({
      full_name: "",
      cpf: "",
      birth_date: "",
      gender: "",
      phone: "",
      email: "",
      city: "",
      shirt_type: formContext?.has_shirt_item ? shirtType : "",
      shirt_size: "",
      has_shirt_item: Boolean(formContext?.has_shirt_item),
      ticket_category_id: ticketCategoryId,
      payment_method: "",
      coupon_code: "",
      notes: "",
    });
    setSubmitState(null);
    setCreatedRegistration(null);
    setPayment(null);
    setPricing(null);
    setPricingError(null);
    setCouponState(null);
  };

  const currentCategory = activeCategories.find((category) => category.id === ticketCategoryId)?.name ?? "Não selecionada";
  const isFormBlocked = Boolean(formUnavailableMessage) || Boolean(createdRegistration);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row">
        <Sidebar />

        <div className="flex-1 space-y-6">
          <TopBar title="Nova inscrição" subtitle="Cadastro de participante" breadcrumbs={[{label:"Início",href:"/painel"},{label:"Inscrições",href:"/inscricoes"},{label:"Nova inscrição"}]} backHref="/inscricoes" fallbackHref="/inscricoes" />

          <SectionCard title="Nova inscrição manual" description="Cadastre a pessoa e configure separadamente a unidade de ingresso.">
            {isLoadingContext ? (
              <div className="mb-4 flex items-center gap-2 rounded-2xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">
                <Loader2 size={16} className="animate-spin" /> Carregando lote e estoque...
              </div>
            ) : null}

            {!isLoadingContext && formUnavailableMessage ? (
              <div className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
                <AlertCircle size={18} />
                <span>Inscrições indisponíveis no momento. {formUnavailableMessage}</span>
              </div>
            ) : null}

            <form className="space-y-6" onSubmit={handleSubmit(onSubmit)}>
              {submitState ? (
                <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${submitState.type === "success" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-red-500/30 bg-red-500/10 text-red-200"}`}>
                  {submitState.type === "success" ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
                  <div>
                    <span>{submitState.message}</span>
                    {submitState.issueWithoutHolderHref ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <Link href={submitState.issueWithoutHolderHref} className="rounded-lg bg-amber-300 px-3 py-2 font-semibold text-slate-950">Emitir sem titular</Link>
                        <button type="button" onClick={() => setSubmitState(null)} className="rounded-lg border border-slate-700 px-3 py-2">Cancelar</button>
                      </div>
                    ) : null}
                  </div>
                </div>
              ) : null}

              {createdRegistration ? (
                <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100">
                  <p className="font-semibold">Inscrição criada com sucesso</p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <p>Participante: {createdRegistration.full_name}</p>
                    <p>Evento: {createdRegistration.event_name}</p>
                    <p>Lote: {createdRegistration.batch_name}</p>
                    <p>Camiseta: {createdRegistration.shirt_type} · {createdRegistration.shirt_size}</p>
                    <p>Preço-base: R$ {Number(createdRegistration.base_amount).toFixed(2)}</p>
                    <p>Desconto: R$ {Number(createdRegistration.discount_amount).toFixed(2)}</p>
                    <p>Cupom aplicado: {createdRegistration.coupon_code ? createdRegistration.coupon_code : "Sem cupom"}</p>
                    <p>Valor final: R$ {Number(createdRegistration.final_amount).toFixed(2)}</p>
                    <p>Status: {payment?.payment_status ?? createdRegistration.payment_status}</p>
                    <p>
                      Reserva: {(payment?.expires_at ?? createdRegistration.reservation_expires_at)
                        ? `expira em ${formatDateTimeBR(payment?.expires_at ?? createdRegistration?.reservation_expires_at ?? null, " às ")}`
                        : "confirmada"}
                    </p>
                    {remainingTimeLabel ? <p>Tempo restante: {remainingTimeLabel}</p> : <p>Tempo restante: --</p>}
                    <p>Forma: {payment?.payment_method ? payment.payment_method : "não definida"}</p>
                  </div>

                  {payment?.pix_qrcode ? (
                    <div className="mt-4 rounded-2xl border border-emerald-500/30 bg-slate-950/40 p-3">
                      <p className="mb-2 text-xs text-emerald-200">QR Code PIX</p>
                      <Image
                        src={payment.pix_qrcode}
                        alt="QR Code PIX"
                        width={176}
                        height={176}
                        unoptimized
                        className="h-44 w-44 rounded-lg border border-slate-700 bg-slate-900"
                      />
                      <p className="mt-2 break-all text-xs text-slate-300">{payment.pix_code}</p>
                      <button
                        type="button"
                        onClick={copyPixCode}
                        className="mt-2 inline-flex items-center gap-1 rounded-lg border border-slate-600 px-2 py-1 text-xs text-slate-200"
                      >
                        <Copy size={12} /> Copiar código
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {payment?.payment_method !== "courtesy" ? (
                      <button
                        type="button"
                        onClick={generatePix}
                        disabled={isGeneratingPix || payment?.payment_status === "paid"}
                        className="rounded-xl border border-cyan-400/40 px-3 py-2 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                      >
                        {isGeneratingPix ? "Gerando PIX..." : "Gerar PIX"}
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={simulatePixPayment}
                      disabled={isSimulatingPix || payment?.payment_status === "paid" || payment?.payment_method === "courtesy"}
                      className="rounded-xl border border-emerald-400/40 px-3 py-2 text-sm font-semibold text-emerald-200 disabled:opacity-50"
                    >
                      {isSimulatingPix ? "Processando..." : "Simular pagamento PIX"}
                    </button>

                    <button
                      type="button"
                      onClick={simulateCardPayment}
                      disabled={isSimulatingCard || payment?.payment_status === "paid"}
                      className="rounded-xl border border-indigo-400/40 px-3 py-2 text-sm font-semibold text-indigo-200 disabled:opacity-50"
                    >
                      {isSimulatingCard ? "Processando..." : "Pagar cartão"}
                    </button>

                    <button
                      type="button"
                      onClick={cancelPayment}
                      disabled={isCancellingPayment || payment?.payment_status === "paid"}
                      className="rounded-xl border border-red-400/40 px-3 py-2 text-sm font-semibold text-red-200 disabled:opacity-50"
                    >
                      {isCancellingPayment ? "Cancelando..." : "Cancelar"}
                    </button>
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={resetForNewRegistration}
                      className="rounded-xl bg-emerald-500 px-3 py-2 text-sm font-semibold text-emerald-950"
                    >
                      Nova inscrição
                    </button>
                    <Link href="/inscricoes" className="rounded-xl border border-emerald-500/40 px-3 py-2 text-sm font-semibold text-emerald-200">
                      Ver inscritos
                    </Link>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <h3 className="text-base font-semibold text-slate-100">Dados do participante</h3>
                  <p className="text-sm text-slate-400">Dados cadastrais da pessoa, independentes do ingresso.</p>
                </div>
                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Nome completo</span>
                  <input {...register("full_name")} disabled={isFormBlocked} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                  {errors.full_name ? <p className="text-sm text-red-400">{errors.full_name.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">CPF</span>
                  <input
                    {...register("cpf")}
                    disabled={isFormBlocked}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    maxLength={14}
                    onChange={(event) => setValue("cpf", formatCpf(event.target.value), { shouldValidate: true })}
                  />
                  {errors.cpf ? <p className="text-sm text-red-400">{errors.cpf.message}</p> : null}
                </label>

                <div className="space-y-2 text-sm">
                  <BirthDateInput
                    name="birth_date"
                    value={birthDateValue ?? ""}
                    onChange={(value) => setValue("birth_date", value, { shouldValidate: true })}
                    disabled={isFormBlocked}
                    required
                    error={errors.birth_date?.message}
                  />
                </div>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Sexo</span>
                  <select
                    {...register("gender", {
                      onChange: () => {
                        setCouponState(null);
                        void refreshPricing(null);
                      },
                    })}
                    disabled={isFormBlocked}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                  >
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
                    disabled={isFormBlocked}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    maxLength={15}
                    onChange={(event) => setValue("phone", formatPhone(event.target.value), { shouldValidate: true })}
                  />
                  {errors.phone ? <p className="text-sm text-red-400">{errors.phone.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">E-mail</span>
                  <input type="email" {...register("email")} disabled={isFormBlocked} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                  {errors.email ? <p className="text-sm text-red-400">{errors.email.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Cidade</span>
                  <input {...register("city")} disabled={isFormBlocked} className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none" />
                </label>

                <div className="mt-2 border-t border-slate-800 pt-5 md:col-span-2">
                  <h3 className="text-base font-semibold text-slate-100">Dados do ingresso</h3>
                  <p className="text-sm text-slate-400">Categoria, lote, pagamento e camiseta pertencem a este ingresso.</p>
                </div>

                <div className="space-y-2 text-sm">
                  <span className="text-slate-300">Evento</span>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-200">
                    {formContext?.active_event_name ?? "Evento selecionado"}
                  </div>
                </div>

                <div className="space-y-2 text-sm">
                  <span className="text-slate-300">Lote</span>
                  <div className="rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-200">
                    {pricing?.batch_name ?? formContext?.batch_name ?? "Lote ativo"}
                  </div>
                </div>

                {formContext?.has_shirt_item ? (
                  <>
                    <label className="space-y-2 text-sm">
                      <select
                        {...register("shirt_type")}
                        className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                        disabled={isFormBlocked}
                        onChange={(event) => {
                          const nextType = event.target.value as keyof typeof SHIRT_SIZES;
                          setShirtType(nextType);
                          setValue("shirt_type", nextType, { shouldValidate: true });
                          setValue("shirt_size", "", { shouldValidate: true });
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
                      <select
                        {...register("shirt_size")}
                        className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                        disabled={isFormBlocked}
                      >
                        <option value="">Selecione</option>
                        {availableSizes.map((size) => (
                          <option key={size} value={size} disabled={getAvailableForSize(shirtType, size) <= 0}>
                            {size} {getAvailableForSize(shirtType, size) <= 0 ? "(esgotado)" : `(${getAvailableForSize(shirtType, size)} disp.)`}
                          </option>
                        ))}
                      </select>
                      {errors.shirt_size ? <p className="text-sm text-red-400">{errors.shirt_size.message}</p> : null}
                    </label>
                  </>
                ) : null}

                <label className="space-y-2 text-sm">
                    <span className="text-slate-300">Categoria de acesso</span>
                    <select
                      {...register("ticket_category_id", {
                        onChange: () => {
                          setCouponState(null);
                          void refreshPricing(null);
                        },
                      })}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                      disabled={isFormBlocked}
                    >
                      <option value="">Selecione</option>
                      {activeCategories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                          {category.available_slots !== null ? ` (${category.available_slots} vagas)` : ""}
                        </option>
                      ))}
                    </select>
                    {errors.ticket_category_id ? <p className="text-sm text-red-400">{errors.ticket_category_id.message}</p> : null}
                </label>

                <label className="space-y-2 text-sm">
                  <span className="text-slate-300">Forma de pagamento</span>
                  <select
                    {...register("payment_method")}
                    className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                    disabled={isFormBlocked}
                  >
                    <option value="">Selecione</option>
                    {paymentMethods.map((method) => (
                      <option key={method.value} value={method.value}>{method.label}</option>
                    ))}
                  </select>
                  {errors.payment_method ? <p className="text-sm text-red-400">{errors.payment_method.message}</p> : null}
                </label>

                <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-950/50 p-4 text-sm md:col-span-2">
                  <p className="text-slate-200 font-semibold">Preco automatico da inscricao</p>
                  {isLoadingPricing ? <p className="text-slate-400">Calculando preco...</p> : null}
                  {pricingError ? <p className="text-amber-300">{pricingError}</p> : null}
                  {!isLoadingPricing && !pricingError && !pricing ? <p className="text-slate-400">Selecione sexo e categoria para calcular o valor.</p> : null}
                  {pricing ? (
                    <div className="grid gap-2 text-slate-200 sm:grid-cols-2">
                      <p>Lote atual: {pricing.batch_name}</p>
                      <p>Categoria: {currentCategory}</p>
                      <p>Preco-base: R$ {Number(pricing.base_amount).toFixed(2)}</p>
                      <p>Desconto: R$ {Number(pricing.discount_amount).toFixed(2)}</p>
                      <p>Valor final: R$ {Number(pricing.final_amount).toFixed(2)}</p>
                      <p>Restam {pricing.remaining_slots} inscricoes neste lote</p>
                    </div>
                  ) : null}
                </div>

                <div className="space-y-2 text-sm md:col-span-2">
                  <span className="text-slate-300">Código</span>
                  <div className="flex flex-col gap-2 md:flex-row">
                    <input
                      {...register("coupon_code", {
                        onChange: () => {
                          setCouponState(null);
                          void refreshPricing(null);
                        },
                      })}
                      disabled={isFormBlocked}
                      className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                      placeholder="Ex: MILITRIN10"
                    />
                    <button
                      type="button"
                      onClick={applyCoupon}
                      disabled={isApplyingCoupon || isFormBlocked}
                      className="rounded-2xl border border-emerald-500/40 px-4 py-2 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-500/10 disabled:opacity-60"
                    >
                      {isApplyingCoupon ? "Validando..." : "Aplicar código"}
                    </button>
                  </div>

                  {couponState ? (
                    <div
                      className={`rounded-2xl border px-4 py-3 text-sm ${
                        couponState.type === "success"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : "border-red-500/30 bg-red-500/10 text-red-200"
                      }`}
                    >
                      <p className="font-medium">{couponState.message}</p>
                      {couponState.type === "success" && pricing ? (
                        <div className="mt-2 space-y-1 text-xs">
                          <p>Valor original: R$ {Number(pricing.base_amount).toFixed(2)}</p>
                          <p>Desconto: {Number(pricing.discount_percent).toFixed(2)}% (R$ {Number(pricing.discount_amount).toFixed(2)})</p>
                          <p>Valor final: R$ {Number(pricing.final_amount).toFixed(2)}</p>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </div>

              <label className="block space-y-2 text-sm">
                <span className="text-slate-300">Observações</span>
                <textarea
                  {...register("notes")}
                  rows={4}
                  disabled={isFormBlocked}
                  className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
                />
              </label>

              {formContext?.kit_enabled ? (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  <p className="font-semibold text-slate-100">Kit do evento</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {formContext.kit_items.map((item) => (
                      <p key={item.id}>
                        {item.name} {item.is_required ? "(obrigatório)" : "(opcional)"} · qtd {item.quantity_per_participant}
                      </p>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
                  Evento sem kit: inscrição funciona apenas como ingresso.
                </div>
              )}

              <div className="flex flex-col gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-2">
                  <Shirt size={18} className="text-emerald-300" />
                  <span>Os tamanhos são validados com base no modelo selecionado.</span>
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting || isFormBlocked}
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
