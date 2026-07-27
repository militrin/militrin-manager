'use client';

import Image from 'next/image';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { SHIRT_SIZES, SHIRT_TYPES } from '@/lib/constants/shirts';
import {
  checkPublicCpfAction,
  createPublicRegistrationAction,
  generatePublicPixAction,
  getPublicPricingPreviewAction,
  saveCheckoutBuyerProfileAction,
  simulatePublicPaymentAction,
} from '@/app/inscricao/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import {
  calculateAge,
  formatCpf,
  formatPhone,
  removeCpfMask,
} from '@/lib/validation/registration';
import { formatDateTimeBR, formatISOToDateBR } from '@/lib/utils/date';

type EventData = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  registration_enabled: boolean;
  registration_open_at: string | null;
  registration_close_at: string | null;
  kit_enabled: boolean;
};

type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  capacity: number | null;
  available_slots: number | null;
  is_active: boolean;
  sort_order: number;
};

type Benefit = { id: string; name: string; description: string | null };

type KitItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  item_type: string;
  quantity_per_participant: number;
  requires_variant: boolean;
  is_required: boolean;
  is_active: boolean;
  sort_order: number;
  variants: Array<{ id: string; name: string; value: string; is_active: boolean }>;
};

type InventoryRow = {
  shirt_type: string;
  shirt_size: string;
  available_quantity: number;
};

type WizardProps = {
  event: EventData;
  isOpen: boolean;
  categories: Category[];
  benefitsByCategory: Record<string, Benefit[]>;
  kitItems: KitItem[];
  inventory: InventoryRow[];
  initialBuyer: {
    full_name: string;
    cpf: string;
    birth_date: string;
    gender: string;
    phone: string;
    email: string;
    city: string;
    privacy_policy_accepted: boolean;
    privacy_policy_accepted_at: string | null;
    missing_fields: string[];
    locked: {
      cpf: boolean;
      birth_date: boolean;
    };
  };
};

type PricingState = {
  batch_id: string;
  batch_name: string;
  sequence_number: number;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  remaining_slots: number;
  coupon_message: string | null;
  coupon_type: string | null;
  discount_percent: number;
};

type RegistrationSnapshot = {
  participant_id: string;
  payment_id: string;
  final_amount: number;
  payment_status: string;
  expires_at: string | null;
  event_id: string;
  event_name: string | null;
  participant_name: string;
  category_name: string | null;
  batch_name: string | null;
  reservation_status: string;
  reservation_expires_at: string | null;
  shirt_type: string | null;
  shirt_size: string | null;
  payment: {
    payment_id: string;
    participant_id: string;
    event_id: string;
    event_name: string | null;
    amount: number;
    discount_amount: number;
    final_amount: number;
    payment_method: string | null;
    payment_status: string;
    pix_code: string | null;
    pix_qrcode: string | null;
    gateway_payment_id: string | null;
    expires_at: string | null;
    paid_at: string | null;
  };
  kit_items: Array<{
    kit_item_id: string;
    item_name: string;
    item_type: string;
    quantity: number;
    status: string;
    delivered_at: string | null;
    variant_data: unknown;
  }>;
  qr_token: string | null;
  order_id: string | null;
  order_number: string | null;
};

type FormState = {
  full_name: string;
  cpf: string;
  birth_date: string;
  gender: string;
  phone: string;
  email: string;
  city: string;
  category_id: string;
  payment_method: 'pix' | 'credit_card';
  coupon_code: string;
  shirt_type: string;
  shirt_size: string;
  lgpd: boolean;
};

type KitSelectionsState = {
  shirtType: string;
  shirtSize: string;
};

const STORAGE_VERSION = 'v2';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function deadlineText(value: string | null) {
  if (!value) return 'sem prazo';
  return formatDateTimeBR(value, ' às ');
}

export function RegistrationWizard({
  event,
  isOpen,
  categories,
  benefitsByCategory,
  kitItems,
  inventory,
  initialBuyer,
}: WizardProps) {
  const canSimulatePayment = process.env.NODE_ENV === 'development';
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [maxUnlockedStep, setMaxUnlockedStep] = useState(1);
  const [liveMessage, setLiveMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [form, setForm] = useState<FormState>({
    full_name: initialBuyer.full_name || '',
    cpf: initialBuyer.cpf ? formatCpf(initialBuyer.cpf) : '',
    birth_date: initialBuyer.birth_date ? formatISOToDateBR(initialBuyer.birth_date) : '',
    gender: initialBuyer.gender || '',
    phone: initialBuyer.phone ? formatPhone(initialBuyer.phone) : '',
    email: initialBuyer.email || '',
    city: initialBuyer.city || '',
    category_id: '',
    payment_method: 'pix',
    coupon_code: '',
    shirt_type: '',
    shirt_size: '',
    lgpd: Boolean(initialBuyer.privacy_policy_accepted),
  });
  const [pricing, setPricing] = useState<PricingState | null>(null);
  const [couponFeedback, setCouponFeedback] = useState<string | null>(null);
  const [couponWorking, setCouponWorking] = useState(false);
  const [registration, setRegistration] = useState<RegistrationSnapshot | null>(null);
  const [shirtType, setShirtType] = useState('');
  const [shirtSize, setShirtSize] = useState('');
  const [kitSelections, setKitSelections] = useState<KitSelectionsState>({
    shirtType: '',
    shirtSize: '',
  });
  const [courtesyMessage, setCourtesyMessage] = useState<string | null>(null);
  const [timeTick, setTimeTick] = useState(() => Date.now());
  const [submitting, setSubmitting] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  const [mobileSummaryOpen, setMobileSummaryOpen] = useState(false);
  const submitLockRef = useRef(false);

  const topRef = useRef<HTMLHeadingElement | null>(null);

  const activeCategories = useMemo(
    () => categories.filter((category) => category.is_active && (category.available_slots === null || category.available_slots > 0)),
    [categories],
  );

  const activeKitItems = useMemo(() => kitItems.filter((item) => item.is_active), [kitItems]);

  const activeShirtItems = useMemo(
    () => activeKitItems.filter((item) => item.item_type === 'shirt'),
    [activeKitItems],
  );

  const hasShirtItem = activeShirtItems.length > 0;
  const hasRequiredShirt = activeShirtItems.some((item) => item.is_required);
  const hasKitStep = activeKitItems.length > 0;
  const totalSteps = hasKitStep ? 7 : 6;

  const availableInventory = useMemo(
    () => inventory.filter((row) => Number(row.available_quantity) > 0),
    [inventory],
  );

  const availableShirtTypes = useMemo(() => {
    return SHIRT_TYPES.map((type) => {
      const total = availableInventory
        .filter((row) => row.shirt_type === type)
        .reduce((acc, row) => acc + Number(row.available_quantity), 0);
      return { type, total };
    });
  }, [availableInventory]);

  const sizeAvailability = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of inventory) {
      map.set(`${row.shirt_type}::${row.shirt_size}`, Number(row.available_quantity));
    }
    return map;
  }, [inventory]);

  const storageKey = useMemo(() => `militrin:wizard:${event.id}:${STORAGE_VERSION}`, [event.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('militrin:last-wizard-next', `/inscricao/${event.slug}`);
  }, [event.slug]);

  useEffect(() => {
    const persisted = sessionStorage.getItem(storageKey);
    if (!persisted) return;
    try {
      const parsed = JSON.parse(persisted) as {
        step: number;
        maxUnlockedStep?: number;
        form: FormState;
        shirtType?: string;
        shirtSize?: string;
        kitSelections?: KitSelectionsState;
        pricing: PricingState | null;
        registration: RegistrationSnapshot | null;
      };
      window.setTimeout(() => {
        if (parsed.form) setForm(parsed.form);
        const restoredShirtType = parsed.shirtType ?? parsed.form?.shirt_type ?? '';
        const restoredShirtSize = parsed.shirtSize ?? parsed.form?.shirt_size ?? '';
        setShirtType(restoredShirtType);
        setShirtSize(restoredShirtSize);
        setKitSelections(parsed.kitSelections ?? { shirtType: restoredShirtType, shirtSize: restoredShirtSize });
        if (parsed.step) setStep(Math.min(7, Math.max(1, parsed.step)));
        if (parsed.maxUnlockedStep) setMaxUnlockedStep(Math.min(7, Math.max(1, parsed.maxUnlockedStep)));
        if (parsed.pricing) setPricing(parsed.pricing);
        if (parsed.registration) setRegistration(parsed.registration);
      }, 0);
    } catch {
      sessionStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  useEffect(() => {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        step,
        maxUnlockedStep,
        form,
        shirtType,
        shirtSize,
        kitSelections,
        pricing,
        registration,
      }),
    );
  }, [form, shirtType, shirtSize, kitSelections, pricing, registration, step, maxUnlockedStep, storageKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimeTick(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    topRef.current?.focus();
  }, [step]);

  const countdownSeconds = (() => {
    if (!registration?.payment?.expires_at || registration.payment.payment_status !== 'pending') {
      return null;
    }
    const seconds = Math.floor((new Date(registration.payment.expires_at).getTime() - timeTick) / 1000);
    return seconds > 0 ? seconds : 0;
  })();

  const ariaLiveMessage = errors.length > 0 ? errors[0] : liveMessage;

  const selectedCategory = activeCategories.find((cat) => cat.id === form.category_id) || null;

  const stepShown = step > 3 && !hasKitStep ? step - 1 : step;

  const cpfLocked = initialBuyer.locked.cpf;
  const birthDateLocked = initialBuyer.locked.birth_date;
  const needsPrivacyConsent = !initialBuyer.privacy_policy_accepted;

  const missingBuyerFields = useMemo(() => {
    const missing: Array<'full_name' | 'cpf' | 'birth_date' | 'gender' | 'phone' | 'city' | 'privacy_policy'> = [];
    if (!form.full_name.trim()) missing.push('full_name');
    if (removeCpfMask(form.cpf).length !== 11) missing.push('cpf');
    if (!form.birth_date.trim()) missing.push('birth_date');
    if (!form.gender.trim()) missing.push('gender');
    if (form.phone.replace(/\D/g, '').length < 10) missing.push('phone');
    if (!form.city.trim()) missing.push('city');
    if (needsPrivacyConsent && !form.lgpd) missing.push('privacy_policy');
    return missing;
  }, [form, needsPrivacyConsent]);

  const buyerProfileComplete = missingBuyerFields.length === 0;
  const buyerDataDirty = useMemo(() => {
    return (
      form.full_name.trim() !== (initialBuyer.full_name ?? '').trim()
      || removeCpfMask(form.cpf) !== String(initialBuyer.cpf ?? '').replace(/\D/g, '')
      || form.birth_date.trim() !== (initialBuyer.birth_date ? formatISOToDateBR(initialBuyer.birth_date) : '')
      || form.gender.trim() !== (initialBuyer.gender ?? '').trim()
      || form.phone.replace(/\D/g, '') !== String(initialBuyer.phone ?? '').replace(/\D/g, '')
      || form.city.trim() !== (initialBuyer.city ?? '').trim()
      || (needsPrivacyConsent && form.lgpd)
    );
  }, [form, initialBuyer, needsPrivacyConsent]);

  const hasActiveReservation = registration?.payment?.payment_status === 'pending' || registration?.reservation_status === 'pending';
  const shouldConfirmLeave = hasActiveReservation || buyerDataDirty;

  function goTo(target: number) {
    const next = Math.min(7, Math.max(1, target));
    if (next > maxUnlockedStep) return;
    setStep(next);
    setErrors([]);
  }

  function unlockAndGoTo(target: number) {
    const normalized = Math.min(7, Math.max(1, target));
    setMaxUnlockedStep((prev) => Math.max(prev, normalized));
    setStep(normalized);
    setErrors([]);
  }

  function canBack() {
    return step > 1 && !submitting;
  }

  function onBack() {
    if (!canBack()) return;
    if (step === 7 && registration?.payment.payment_status === 'paid') return;
    if (!hasKitStep && step === 4) {
      goTo(2);
      return;
    }
    goTo(step - 1);
  }

  function onClickMinhaConta() {
    if (!shouldConfirmLeave) {
      router.push('/minha-conta');
      return;
    }
    setShowLeaveConfirm(true);
  }

  function onConfirmLeaveWizard() {
    setShowLeaveConfirm(false);
    router.push('/minha-conta');
  }

  function setField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function setKitField(nextType: string, nextSize: string) {
    setShirtType(nextType);
    setShirtSize(nextSize);
    setKitSelections({ shirtType: nextType, shirtSize: nextSize });
    setForm((prev) => ({
      ...prev,
      shirt_type: nextType,
      shirt_size: nextSize,
    }));
  }

  async function handleCategoryNext() {
    if (!form.category_id) {
      setErrors(['Selecione uma categoria para continuar.']);
      return;
    }

    const category = activeCategories.find((item) => item.id === form.category_id);
    if (!category) {
      setErrors(['A categoria escolhida não está disponível.']);
      return;
    }

    startTransition(async () => {
      const result = await getPublicPricingPreviewAction({
        event_id: event.id,
        ticket_category_id: form.category_id,
        gender: form.gender || 'male',
        coupon_code: form.coupon_code || undefined,
      });
      if (!result.success || !result.pricing) {
        setErrors([result.message || 'Falha ao calcular o valor.']);
        return;
      }
      setPricing(result.pricing as PricingState);
      setLiveMessage('Categoria validada e preço atualizado.');
      unlockAndGoTo(2);
    });
  }

  async function handlePersonalNext() {
    const nextErrors: string[] = [];
    if (!form.full_name.trim()) nextErrors.push('Informe o nome completo.');
    if (removeCpfMask(form.cpf).length !== 11) nextErrors.push('CPF inválido.');
    if (!form.birth_date.trim()) nextErrors.push('Informe a data de nascimento.');
    if (!form.gender.trim()) nextErrors.push('Informe o gênero.');
    if (form.phone.replace(/\D/g, '').length < 10) nextErrors.push('Telefone é obrigatório.');
    if (!form.city.trim()) nextErrors.push('Cidade é obrigatória.');
    if (needsPrivacyConsent && !form.lgpd) nextErrors.push('Você precisa aceitar o consentimento de dados para continuar.');
    if (!form.category_id) nextErrors.push('Selecione uma categoria antes de avançar.');

    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }

    const profileSave = await saveCheckoutBuyerProfileAction({
      full_name: form.full_name,
      cpf: removeCpfMask(form.cpf),
      birth_date: form.birth_date,
      gender: form.gender,
      phone: form.phone,
      city: form.city,
      accept_privacy: form.lgpd,
      privacy_policy_version: 'v2026-07',
    });

    if (!profileSave.success) {
      setErrors([profileSave.message || 'Nao foi possivel salvar os dados do comprador.']);
      return;
    }

    setForm((prev) => ({
      ...prev,
      full_name: profileSave.profile.full_name || prev.full_name,
      cpf: profileSave.profile.cpf ? formatCpf(profileSave.profile.cpf) : prev.cpf,
      birth_date: profileSave.profile.birth_date ? formatISOToDateBR(profileSave.profile.birth_date) : prev.birth_date,
      gender: profileSave.profile.gender || prev.gender,
      phone: profileSave.profile.phone ? formatPhone(profileSave.profile.phone) : prev.phone,
      city: profileSave.profile.city || prev.city,
      email: profileSave.profile.email || prev.email,
      lgpd: profileSave.profile.privacy_policy_accepted || prev.lgpd,
    }));

    startTransition(async () => {
      const cpfCheck = await checkPublicCpfAction({ event_id: event.id, cpf: form.cpf });
      if (!cpfCheck.success) {
        setErrors([cpfCheck.message || 'CPF já utilizado neste evento.']);
        return;
      }

      const preview = await getPublicPricingPreviewAction({
        event_id: event.id,
        ticket_category_id: form.category_id,
        gender: form.gender,
        coupon_code: form.coupon_code || undefined,
      });

      if (!preview.success || !('pricing' in preview)) {
        setErrors([('message' in preview && preview.message) || 'Não foi possível atualizar o preço.']);
        return;
      }

      setPricing(preview.pricing as PricingState);
      setLiveMessage('Seus dados foram carregados da sua conta e o valor foi recalculado.');
      unlockAndGoTo(hasKitStep ? 3 : 4);
    });
  }

  async function handleKitNext() {
    const nextErrors: string[] = [];

    if (hasRequiredShirt) {
      if (!shirtType) nextErrors.push('Selecione o modelo da camiseta.');
      if (!shirtSize) nextErrors.push('Selecione o tamanho da camiseta.');
    }

    if (shirtType && shirtSize) {
      const available = Number(sizeAvailability.get(`${shirtType}::${shirtSize}`) ?? 0);
      if (available <= 0) {
        nextErrors.push('O tamanho selecionado esta sem estoque. Escolha outra opcao.');
      }
    }

    if (nextErrors.length > 0) {
      setErrors(nextErrors);
      return;
    }

    setForm((prev) => ({
      ...prev,
      shirt_type: shirtType,
      shirt_size: shirtSize,
    }));

    unlockAndGoTo(4);
  }

  async function handleApplyCoupon() {
    if (!form.category_id) {
      setErrors(['Escolha uma categoria antes de aplicar cupom.']);
      return;
    }

    setCouponWorking(true);
    setCouponFeedback(null);
    const result = await getPublicPricingPreviewAction({
      event_id: event.id,
      ticket_category_id: form.category_id,
      gender: form.gender || 'male',
      coupon_code: form.coupon_code || undefined,
    });
    setCouponWorking(false);

    if (!result.success || !('pricing' in result)) {
      setCouponFeedback(('message' in result && result.message) || 'Cupom inválido para esta inscrição.');
      return;
    }

    const priced = result.pricing as PricingState | undefined;
    if (!priced) {
      setCouponFeedback('Cupom inválido para esta inscrição.');
      return;
    }

    setPricing(priced);
    setCouponFeedback(priced.coupon_message || 'Cupom aplicado com sucesso.');
  }

  async function handleCreateAndContinuePayment() {
    if (submitting || submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setErrors([]);

    const requestId = `${event.id}:${form.category_id}:${removeCpfMask(form.cpf)}`;

    const payload = {
      event_id: event.id,
      ticket_category_id: form.category_id,
      full_name: form.full_name,
      cpf: removeCpfMask(form.cpf),
      birth_date: form.birth_date,
      gender: form.gender,
      phone: form.phone,
      email: form.email,
      city: form.city || undefined,
      shirt_type: hasShirtItem ? shirtType || undefined : undefined,
      shirt_size: hasShirtItem ? shirtSize || undefined : undefined,
      payment_method: form.payment_method,
      coupon_code: form.coupon_code || undefined,
      notes: 'Portal público de inscrição',
      client_request_id: requestId,
    } as const;

    let result: Awaited<ReturnType<typeof createPublicRegistrationAction>>;
    try {
      result = await createPublicRegistrationAction(payload);
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }

    if (!result.success || !('registration' in result)) {
      setErrors([('message' in result && result.message) || 'Não foi possível criar sua inscrição.']);
      return;
    }

    const createdRegistration = result.registration;
    if (!createdRegistration) {
      setErrors(['Nao foi possivel carregar os dados do pedido criado.']);
      return;
    }

    setRegistration(createdRegistration as RegistrationSnapshot);
    setCourtesyMessage(result.courtesy_message ?? null);
    setLiveMessage('Inscrição criada.');

    if ((createdRegistration.final_amount ?? 0) <= 0) {
      unlockAndGoTo(7);
      sessionStorage.removeItem(storageKey);
      return;
    }

    if (form.payment_method === 'pix') {
      const pix = await generatePublicPixAction(createdRegistration.participant_id);
      if (!pix.success || !pix.payment) {
        setErrors([pix.message || 'Falha ao gerar PIX.']);
        return;
      }
      setRegistration((prev) =>
        prev
          ? {
              ...prev,
              payment: {
                ...prev.payment,
                ...pix.payment,
              },
            }
          : prev,
      );
    }

    unlockAndGoTo(6);
  }

  async function handleSimulatePaid() {
    if (!registration) return;
    startTransition(async () => {
      const method = (form.payment_method === 'credit_card' ? 'credit_card' : 'pix') as 'pix' | 'credit_card';
      const paid = await simulatePublicPaymentAction(registration.participant_id, method);
      if (!paid.success || !('payment' in paid)) {
        setErrors([('message' in paid && paid.message) || 'Não foi possível confirmar o pagamento.']);
        return;
      }
      setRegistration((prev) =>
        prev
          ? {
              ...prev,
              payment: {
                ...prev.payment,
                ...paid.payment,
              },
              order_id: paid.order_id ?? prev.order_id,
              order_number: paid.order_number ?? prev.order_number,
              reservation_status: paid.reservation_status ?? prev.reservation_status,
              reservation_expires_at: paid.reservation_expires_at ?? prev.reservation_expires_at,
              qr_token: paid.qr_token ?? prev.qr_token,
            }
          : prev,
      );
      setLiveMessage('Pagamento confirmado.');
      sessionStorage.removeItem(storageKey);
      unlockAndGoTo(7);
    });
  }

  function restartWizard() {
    sessionStorage.removeItem(storageKey);
    router.refresh();
  }

  const progress = (stepShown / totalSteps) * 100;
  const visibleTotalSteps = hasKitStep ? 7 : 6;
  const trail = hasKitStep
    ? [
        { id: 1, label: 'Evento' },
        { id: 2, label: 'Dados' },
        { id: 3, label: 'Categoria' },
        { id: 4, label: 'Camiseta' },
        { id: 5, label: 'Pagamento' },
        { id: 6, label: 'Resumo' },
        { id: 7, label: 'Concluído' },
      ]
    : [
        { id: 1, label: 'Evento' },
        { id: 2, label: 'Dados' },
        { id: 4, label: 'Pagamento' },
        { id: 5, label: 'Resumo' },
        { id: 6, label: 'Concluído' },
      ];

  const summaryValues = {
    event: event.name,
    category: selectedCategory?.name || 'Não selecionado',
    batch: pricing?.batch_name || 'Não selecionado',
    gender: form.gender ? (form.gender === 'female' ? 'Feminino' : form.gender === 'male' ? 'Masculino' : form.gender) : 'Não selecionado',
    shirt: hasShirtItem ? (shirtType || 'Não selecionado') : 'Não selecionado',
    size: hasShirtItem ? (shirtSize || 'Não selecionado') : 'Não selecionado',
    coupon: form.coupon_code || 'Não selecionado',
    original: money(pricing?.base_amount || 0),
    discount: money(pricing?.discount_amount || 0),
    total: money(pricing?.final_amount || 0),
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-5 text-slate-100 sm:px-6">
      <div className="mx-auto w-full max-w-6xl">
        <div className="mb-4 rounded-3xl border border-slate-800/80 bg-slate-900/70 p-4 sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onBack}
                disabled={!canBack()}
                className="h-10 rounded-xl border border-slate-700 px-3 text-sm text-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                ← Voltar
              </button>
              <Link href="/" className="rounded-xl border border-emerald-500/30 px-3 py-2 text-xs uppercase tracking-[0.2em] text-emerald-200">
                Militrin
              </Link>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClickMinhaConta}
                className="h-10 rounded-xl border border-slate-700 px-3 text-sm text-slate-200"
              >
                ← Minha conta
              </button>
              <Link href="/inscricao" className="h-10 rounded-xl border border-slate-700 px-3 text-sm leading-10 text-slate-200">
                Voltar para eventos
              </Link>
            </div>
          </div>

          <h1 ref={topRef} tabIndex={-1} className="mt-4 text-2xl font-semibold outline-none sm:text-3xl">
            {event.name}
          </h1>
          <p className="mt-1 text-sm text-slate-300">{event.description || 'Preencha seus dados e finalize sua inscrição.'}</p>

          <div className="mt-4 flex gap-2 overflow-x-auto pb-1">
            {trail.map((item) => {
              const active = step === item.id;
              const done = maxUnlockedStep > item.id;
              const blocked = item.id > maxUnlockedStep;
              return (
                <button
                  key={item.id}
                  type="button"
                  disabled={blocked}
                  onClick={() => goTo(item.id)}
                  className={`whitespace-nowrap rounded-full border px-3 py-1.5 text-xs transition ${
                    active
                      ? 'border-emerald-400 bg-emerald-500/15 text-emerald-200'
                      : done
                        ? 'border-slate-600 text-slate-200 hover:border-slate-400'
                        : 'border-slate-800 text-slate-500'
                  }`}
                >
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}>
            <div className="h-full rounded-full bg-emerald-400 transition-all" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-400">Etapa {Math.min(stepShown, visibleTotalSteps)} de {visibleTotalSteps}</p>
        </div>

        <p aria-live="polite" className="sr-only">
          {ariaLiveMessage}
        </p>

        {!isOpen ? (
          <section className="rounded-3xl border border-amber-700/30 bg-amber-950/30 p-6 text-amber-100">
            Este evento está com inscrições fechadas no momento.
          </section>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5 sm:p-6">
              <button
                type="button"
                onClick={() => setMobileSummaryOpen((prev) => !prev)}
                className="mb-4 w-full rounded-2xl border border-slate-700 px-4 py-3 text-left text-sm text-slate-200 lg:hidden"
              >
                Resumo da compra {mobileSummaryOpen ? '▲' : '▼'}
              </button>

              {mobileSummaryOpen ? (
                <div className="mb-4 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200 lg:hidden">
                  <p className="text-base font-semibold">{summaryValues.event}</p>
                  <p className="mt-2">Categoria: {summaryValues.category}</p>
                  <p>Lote: {summaryValues.batch}</p>
                  <p>Gênero: {summaryValues.gender}</p>
                  <p>Camiseta: {summaryValues.shirt}</p>
                  <p>Tamanho: {summaryValues.size}</p>
                  <p>Cupom: {summaryValues.coupon}</p>
                  <p className="mt-3">Valor original: {summaryValues.original}</p>
                  <p>Desconto: {summaryValues.discount}</p>
                  <p className="text-emerald-300">Total: {summaryValues.total}</p>
                </div>
              ) : null}

              {errors.length > 0 && (
              <div className="mb-5 rounded-2xl border border-rose-600/40 bg-rose-950/30 p-4 text-sm text-rose-100" role="alert">
                <strong className="mb-2 block">Verifique os campos abaixo:</strong>
                <ul className="list-disc space-y-1 pl-5">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
              )}

            {step === 1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">1. Escolha sua categoria</h2>
                {activeCategories.length === 0 ? (
                  <p className="text-sm text-slate-300">Não há categorias com vagas disponíveis para este evento.</p>
                ) : (
                  <div className="grid gap-3">
                    {activeCategories.map((category) => {
                      const selected = form.category_id === category.id;
                      const benefits = benefitsByCategory[category.id] || [];
                      return (
                        <label
                          key={category.id}
                          className={`cursor-pointer rounded-2xl border p-4 transition ${
                            selected ? 'border-emerald-400 bg-emerald-900/20' : 'border-slate-700 hover:border-slate-500'
                          }`}
                        >
                          <input
                            type="radio"
                            className="sr-only"
                            name="category"
                            value={category.id}
                            checked={selected}
                            onChange={() => setField('category_id', category.id)}
                          />
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="text-base font-semibold text-white">{category.name}</p>
                              <p className="text-sm text-slate-300">{category.description || 'Categoria sem descrição.'}</p>
                              {benefits.length > 0 && (
                                <p className="mt-2 text-xs text-emerald-200">Inclui: {benefits.map((benefit) => benefit.name).join(', ')}</p>
                              )}
                            </div>
                            <span className="rounded-full bg-slate-800 px-2 py-1 text-xs text-slate-300">
                              {category.available_slots === null ? 'Vagas ilimitadas' : `${category.available_slots} vagas`}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    disabled={isPending || activeCategories.length === 0}
                    onClick={handleCategoryNext}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
                  >
                    {isPending ? 'Validando...' : 'Continuar'}
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">2. Seus dados</h2>
                {buyerProfileComplete ? (
                  <div className="rounded-2xl border border-emerald-600/40 bg-emerald-950/20 p-4 text-sm text-emerald-100">
                    <p className="text-base font-semibold">Dados do comprador</p>
                    <p className="mt-3">{form.full_name}</p>
                    <p>CPF: {formatCpf(removeCpfMask(form.cpf)).replace(/(\d{3}\.\d{3}\.\d{3}-)(\d{2})$/, '***.***.***-$2')}</p>
                    <p>Nascimento: {form.birth_date}</p>
                    <p>{form.gender === 'female' ? 'Feminino' : form.gender === 'male' ? 'Masculino' : form.gender}</p>
                    <p>{form.phone}</p>
                    <p>{form.email}</p>
                    <p>{form.city}</p>
                    <p className="mt-2 text-emerald-200">Seus dados foram carregados da sua conta.</p>
                  </div>
                ) : (
                  <>
                    <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                      Precisamos apenas completar algumas informações.
                    </p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {missingBuyerFields.includes('full_name') && (
                        <label className="space-y-1 sm:col-span-2">
                          <span className="text-sm text-slate-200">Nome completo</span>
                          <input
                            value={form.full_name}
                            onChange={(event_) => setField('full_name', event_.target.value)}
                            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                          />
                        </label>
                      )}

                      {missingBuyerFields.includes('cpf') && (
                        <label className="space-y-1">
                          <span className="text-sm text-slate-200">CPF</span>
                          <input
                            value={form.cpf}
                            onChange={(event_) => setField('cpf', formatCpf(event_.target.value))}
                            inputMode="numeric"
                            readOnly={cpfLocked}
                            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm read-only:cursor-not-allowed read-only:bg-slate-900/50"
                          />
                        </label>
                      )}

                      {missingBuyerFields.includes('birth_date') && (
                        <div className="space-y-1">
                          <BirthDateInput
                            name="birth_date"
                            value={form.birth_date}
                            onChange={(value) => setField('birth_date', value)}
                            required
                            disabled={birthDateLocked}
                            className="space-y-1"
                            label="Nascimento"
                          />
                          {form.birth_date && (
                            <span className="text-xs text-slate-400">Idade: {calculateAge(form.birth_date)} anos</span>
                          )}
                        </div>
                      )}

                      {missingBuyerFields.includes('gender') && (
                        <label className="space-y-1">
                          <span className="text-sm text-slate-200">Gênero</span>
                          <select
                            value={form.gender}
                            onChange={(event_) => setField('gender', event_.target.value)}
                            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                          >
                            <option value="">Selecione</option>
                            <option value="male">Masculino</option>
                            <option value="female">Feminino</option>
                            <option value="other">Outro</option>
                          </select>
                        </label>
                      )}

                      {missingBuyerFields.includes('phone') && (
                        <label className="space-y-1">
                          <span className="text-sm text-slate-200">Telefone</span>
                          <input
                            value={form.phone}
                            onChange={(event_) => setField('phone', formatPhone(event_.target.value))}
                            inputMode="numeric"
                            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                          />
                        </label>
                      )}

                      {missingBuyerFields.includes('city') && (
                        <label className="space-y-1 sm:col-span-2">
                          <span className="text-sm text-slate-200">Cidade</span>
                          <input
                            value={form.city}
                            onChange={(event_) => setField('city', event_.target.value)}
                            className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                          />
                        </label>
                      )}
                    </div>
                  </>
                )}

                <label className="space-y-1">
                  <span className="text-sm text-slate-200">E-mail</span>
                  <input
                    type="email"
                    readOnly
                    value={form.email}
                    className="h-11 w-full cursor-not-allowed rounded-xl border border-slate-700 bg-slate-900/50 px-3 text-sm text-slate-300"
                  />
                </label>

                {needsPrivacyConsent ? (
                  <label className="mt-2 flex items-start gap-2 rounded-xl border border-slate-700 p-3 text-sm text-slate-300">
                    <input
                      type="checkbox"
                      checked={form.lgpd}
                      onChange={(event_) => setField('lgpd', event_.target.checked)}
                      className="mt-1"
                    />
                    <span>Autorizo o uso dos meus dados para gestão da minha inscrição no evento.</span>
                  </label>
                ) : (
                  <p className="text-xs text-emerald-200">Consentimento de privacidade já registrado na sua conta.</p>
                )}

                <div className="flex flex-wrap justify-end gap-2">
                  <Link
                    href={`/minha-conta/dados?next=${encodeURIComponent(`/inscricao/${event.slug}`)}`}
                    className="inline-flex h-11 items-center justify-center rounded-2xl border border-slate-700 px-5 text-sm text-slate-200"
                  >
                    Atualizar meus dados
                  </Link>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={handlePersonalNext}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
                  >
                    {isPending ? 'Validando...' : 'Continuar'}
                  </button>
                </div>
              </div>
            )}

            {step === 3 && hasKitStep && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">3. Kit</h2>

                <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">
                  <p className="font-medium text-slate-100">Itens ativos do kit</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {activeKitItems.map((item) => (
                      <li key={item.id}>
                        {item.name} x{item.quantity_per_participant}
                        {item.is_required ? ' (obrigatorio)' : ' (opcional)'}
                      </li>
                    ))}
                  </ul>
                </div>

                {hasShirtItem ? (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1">
                      <span className="text-sm text-slate-200">Tipo</span>
                      <select
                        value={shirtType}
                        onChange={(event_) => setKitField(event_.target.value, '')}
                        className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                      >
                        <option value="">{hasRequiredShirt ? 'Selecione' : 'Nao selecionar camiseta'}</option>
                        {availableShirtTypes.map((item) => (
                          <option key={item.type} value={item.type} disabled={item.total <= 0}>
                            {item.type} {item.total > 0 ? `(${item.total} disponiveis)` : '(sem estoque)'}
                          </option>
                        ))}
                      </select>
                    </label>

                    <label className="space-y-1">
                      <span className="text-sm text-slate-200">Tamanho</span>
                      <select
                        value={shirtSize}
                        onChange={(event_) => setKitField(shirtType, event_.target.value)}
                        disabled={!shirtType}
                        className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm disabled:opacity-50"
                      >
                        <option value="">Selecione</option>
                        {(shirtType ? SHIRT_SIZES[shirtType as keyof typeof SHIRT_SIZES] ?? [] : []).map((size) => {
                          const available = Number(sizeAvailability.get(`${shirtType}::${size}`) ?? 0);
                          return (
                            <option key={size} value={size} disabled={available <= 0}>
                              {size} {available > 0 ? `(${available} disponiveis)` : '(sem estoque)'}
                            </option>
                          );
                        })}
                      </select>
                    </label>
                  </div>
                ) : (
                  <p className="text-sm text-slate-300">Este evento possui kit sem camiseta. Revise os itens acima e continue.</p>
                )}

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleKitNext}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">4. Cupom</h2>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="space-y-1 sm:col-span-2">
                    <span className="text-sm text-slate-200">Cupom (opcional)</span>
                    <div className="flex gap-2">
                      <input
                        value={form.coupon_code}
                        onChange={(event_) => setField('coupon_code', event_.target.value.toUpperCase())}
                        className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm"
                      />
                      <button
                        type="button"
                        onClick={handleApplyCoupon}
                        disabled={couponWorking}
                        className="rounded-xl border border-emerald-500 px-3 text-sm text-emerald-300 disabled:opacity-50"
                      >
                        {couponWorking ? '...' : 'Aplicar'}
                      </button>
                    </div>
                    {couponFeedback && <span className="text-xs text-emerald-200">{couponFeedback}</span>}
                  </label>

                  <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">
                    <p>Quantidade de ingressos: <strong>1</strong></p>
                    <p className="text-xs text-slate-400">Nesta sprint, quantidade fixa em 1. Fluxo já preparado para evolução futura com itens de pedido.</p>
                  </div>

                  <div className="rounded-xl border border-slate-700 bg-slate-950 p-3 text-sm text-slate-200">
                    <p>Categoria: {selectedCategory?.name || '-'}</p>
                    <p>Lote: {pricing?.batch_name || '-'}</p>
                    <p>Valor base: {money(pricing?.base_amount || 0)}</p>
                    <p>Desconto: {money(pricing?.discount_amount || 0)}</p>
                    <p className="mt-1 text-base font-semibold text-emerald-300">Total: {money(pricing?.final_amount || 0)}</p>
                    {Number(pricing?.final_amount ?? 0) <= 0 ? (
                      <p className="mt-2 text-xs text-emerald-200">Cortesia aplicada. Nenhum pagamento sera necessario.</p>
                    ) : null}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => unlockAndGoTo(5)}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
                  >
                    Continuar
                  </button>
                </div>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">5. Resumo e pagamento</h2>
                <div className="grid gap-3 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200 sm:grid-cols-2">
                  <p>
                    <strong>Nome:</strong> {form.full_name}
                  </p>
                  <p>
                    <strong>CPF:</strong> {formatCpf(removeCpfMask(form.cpf))}
                  </p>
                  <p>
                    <strong>Nascimento:</strong> {form.birth_date}
                  </p>
                  <p>
                    <strong>Gênero:</strong> {form.gender === 'female' ? 'Feminino' : 'Masculino'}
                  </p>
                  <p>
                    <strong>Telefone:</strong> {form.phone}
                  </p>
                  <p>
                    <strong>Cidade:</strong> {form.city}
                  </p>
                  <p>
                    <strong>Categoria:</strong> {selectedCategory?.name || '-'}
                  </p>
                  <p>
                    <strong>Quantidade:</strong> 1
                  </p>
                  <p>
                    <strong>Lote:</strong> {pricing?.batch_name || '-'}
                  </p>
                  <p>
                    <strong>Cupom:</strong> {form.coupon_code || 'Sem cupom'}
                  </p>
                  <p>
                    <strong>Preco:</strong> {money(pricing?.base_amount || 0)}
                  </p>
                  <p>
                    <strong>Desconto:</strong> {money(pricing?.discount_amount || 0)}
                  </p>
                  {Number(pricing?.final_amount ?? 0) > 0 ? (
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-sm text-slate-200">Forma de pagamento</span>
                      <select
                        value={form.payment_method}
                        onChange={(event_) => setField('payment_method', event_.target.value as FormState['payment_method'])}
                        className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm"
                      >
                        <option value="pix">PIX</option>
                        <option value="credit_card">Cartao</option>
                      </select>
                    </label>
                  ) : (
                    <p className="sm:col-span-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-100">
                      Cupom de cortesia aplicado. Valor final zerado automaticamente.
                    </p>
                  )}
                  <p>
                    <strong>Pagamento:</strong> {Number(pricing?.final_amount ?? 0) <= 0 ? 'Nao necessario (cortesia)' : form.payment_method === 'credit_card' ? 'Cartao' : 'PIX'}
                  </p>
                  <p>
                    <strong>Total:</strong> {money(pricing?.final_amount || 0)}
                  </p>
                  {hasShirtItem && (
                    <p className="sm:col-span-2">
                      <strong>Camiseta:</strong> {shirtType || '-'} / {shirtSize || '-'}
                    </p>
                  )}
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreateAndContinuePayment}
                    disabled={submitting}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
                  >
                    {submitting ? 'Criando pedido...' : 'Criar pedido'}
                  </button>
                </div>
              </div>
            )}

            {step === 6 && registration && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">6. Pagamento do pedido</h2>

                <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                  <p>
                    Participante: <strong>{registration.participant_name}</strong>
                  </p>
                  <p>
                    Valor: <strong className="text-emerald-300">{money(registration.payment.final_amount)}</strong>
                  </p>
                  <p>
                    Status: <strong>{registration.payment.payment_status}</strong>
                  </p>
                  <p>
                    Expira em: <strong>{deadlineText(registration.payment.expires_at)}</strong>
                  </p>
                  {countdownSeconds !== null && (
                    <p>
                      Tempo restante: <strong>{Math.floor(countdownSeconds / 60)}m {countdownSeconds % 60}s</strong>
                    </p>
                  )}
                </div>

                {form.payment_method === 'pix' && (
                  <div className="space-y-3 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                    <p className="font-medium">Use o código PIX abaixo:</p>
                    <textarea readOnly value={registration.payment.pix_code || ''} className="h-28 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-xs" />
                    {registration.payment.pix_qrcode && (
                      <Image
                        src={registration.payment.pix_qrcode}
                        alt="QR Code PIX"
                        width={176}
                        height={176}
                        unoptimized
                        className="h-44 w-44 rounded-xl border border-slate-700 bg-white p-2"
                      />
                    )}
                  </div>
                )}

                {registration.payment.payment_status !== 'paid' ? (
                  <div className="flex flex-wrap gap-2">
                    {canSimulatePayment ? (
                      <button
                        type="button"
                        onClick={handleSimulatePaid}
                        disabled={isPending}
                        className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
                      >
                        {isPending ? 'Processando...' : 'Pagar agora (simulado dev)'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => unlockAndGoTo(7)}
                      className="h-11 rounded-2xl border border-slate-700 px-6 text-sm text-slate-200"
                    >
                      Ver resumo do pedido
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => unlockAndGoTo(7)}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
                  >
                    Ver confirmação
                  </button>
                )}
              </div>
            )}

            {step === 7 && registration && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">7. Resumo final do pedido</h2>
                <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4 text-sm text-emerald-100">
                  <p>
                    Inscrição registrada para <strong>{registration.participant_name}</strong>.
                  </p>
                  <p>
                    Status da inscrição: <strong>{registration.reservation_status}</strong>
                  </p>
                  <p>
                    Status do pagamento: <strong>{registration.payment.payment_status}</strong>
                  </p>
                  <p>
                    Total pago: <strong>{money(registration.payment.final_amount)}</strong>
                  </p>
                  {courtesyMessage ? <p>{courtesyMessage}</p> : null}
                  <p>
                    Protocolo: <strong>{registration.participant_id}</strong>
                  </p>
                  {registration.order_number ? (
                    <p>
                      Pedido: <strong>{registration.order_number}</strong>
                    </p>
                  ) : null}
                </div>

                <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <p><strong>Evento:</strong> {event.name}</p>
                    <p><strong>Categoria:</strong> {registration.category_name || '-'}</p>
                    <p><strong>Lote:</strong> {registration.batch_name || '-'}</p>
                    <p><strong>Camiseta:</strong> {registration.shirt_type || '-'} / {registration.shirt_size || '-'}</p>
                    <p><strong>Valor original:</strong> {money(registration.payment.amount)}</p>
                    <p><strong>Desconto:</strong> {money(registration.payment.discount_amount)}</p>
                    <p><strong>Valor final:</strong> {money(registration.payment.final_amount)}</p>
                    <p><strong>Status:</strong> {registration.payment.payment_status}</p>
                  </div>

                  {registration.payment.payment_status === 'paid' && registration.qr_token ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-emerald-200">Pagamento confirmado. QR Code e PDF já estão disponíveis.</p>
                      <TicketViewer
                        eventName={event.name}
                        participantName={registration.participant_name}
                        status="active"
                        categoryName={registration.category_name}
                        eventDate={event.starts_at ? formatDateTimeBR(String(event.starts_at), ' às ') : null}
                        eventLocation={event.location}
                        token={registration.qr_token}
                      />
                    </div>
                  ) : (
                    <div className="mt-4 space-y-3">
                      <p>Pagamento pendente. O QR Code e o PDF serão liberados somente após confirmação.</p>
                      {canSimulatePayment ? (
                        <button
                          type="button"
                          onClick={handleSimulatePaid}
                          disabled={isPending}
                          className="h-10 rounded-xl bg-emerald-500 px-4 text-xs font-semibold text-emerald-950 disabled:opacity-50"
                        >
                          {isPending ? 'Processando...' : 'Pagar agora (simulado dev)'}
                        </button>
                      ) : null}
                    </div>
                  )}

                  {registration.kit_items.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {registration.kit_items.map((item) => (
                        <li key={item.kit_item_id}>
                          {item.item_name} x{item.quantity} - {item.status}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2">Sem itens de kit vinculados.</p>
                  )}
                </div>

                <div className="flex flex-wrap gap-3">
                  {registration.payment.payment_status === 'paid' ? (
                    <Link
                      href="/minha-conta/ingressos"
                      className="inline-flex h-11 items-center justify-center rounded-2xl border border-emerald-500/40 px-5 text-sm text-emerald-200"
                    >
                      Ver meus ingressos
                    </Link>
                  ) : null}
                  <Link
                    href={registration.order_id ? `/minha-conta/compras/${registration.order_id}` : '/minha-conta/compras'}
                    className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-5 text-sm font-semibold text-emerald-950"
                  >
                    Acessar minhas compras
                  </Link>
                  <button
                    type="button"
                    onClick={restartWizard}
                    className="h-11 rounded-2xl border border-slate-700 px-5 text-sm text-slate-200"
                  >
                    Nova inscrição
                  </button>
                </div>
              </div>
            )}
            </section>

            <aside className="hidden lg:block">
              <div className="sticky top-5 rounded-3xl border border-slate-800/80 bg-slate-900/75 p-4 text-sm text-slate-200">
                <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Resumo da compra</p>
                <p className="mt-3 text-base font-semibold text-white">{summaryValues.event}</p>
                <div className="mt-3 space-y-1">
                  <p>Categoria: {summaryValues.category}</p>
                  <p>Lote: {summaryValues.batch}</p>
                  <p>Gênero: {summaryValues.gender}</p>
                  <p>Camiseta: {summaryValues.shirt}</p>
                  <p>Tamanho: {summaryValues.size}</p>
                  <p>Cupom: {summaryValues.coupon}</p>
                </div>
                <div className="mt-4 border-t border-slate-800 pt-3">
                  <p>Valor original: {summaryValues.original}</p>
                  <p>Desconto: {summaryValues.discount}</p>
                  <p className="font-semibold text-emerald-300">Total: {summaryValues.total}</p>
                </div>
              </div>
            </aside>
          </div>
        )}

        {showLeaveConfirm ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/75 px-4">
            <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 text-slate-100">
              <h3 className="text-lg font-semibold">Sair da compra?</h3>
              <p className="mt-2 text-sm text-slate-300">Deseja sair da compra? Sua reserva ou alterações poderão ser perdidas.</p>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowLeaveConfirm(false)}
                  className="h-10 rounded-xl border border-slate-700 px-4 text-sm text-slate-200"
                >
                  Continuar comprando
                </button>
                <button
                  type="button"
                  onClick={onConfirmLeaveWizard}
                  className="h-10 rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950"
                >
                  Sair da compra
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </main>
  );
}
