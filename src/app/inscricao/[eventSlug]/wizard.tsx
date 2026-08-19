'use client';

import Image from 'next/image';
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { SHIRT_TYPES, makeShirtInventoryKey, normalizeShirtSize, normalizeShirtType } from '@/lib/constants/shirts';
import {
  createPublicMultiOrderAction,
  generatePublicOrderPixAction,
  getPublicBuyerTicketHolderStatusAction,
  getPublicOrderSnapshotAction,
  getPublicPricingPreviewAction,
  saveCheckoutBuyerProfileAction,
  simulatePublicOrderPaymentAction,
} from '@/app/inscricao/actions';
import { TicketViewer } from '@/components/public/TicketViewer';
import {
  formatCpf,
  formatPhone,
  removeCpfMask,
} from '@/lib/validation/registration';
import { calculateAgeAtEventDate, formatDateTimeBR, formatISOToDateBR, isMinimumAgeSatisfied } from '@/lib/utils/date';
import { describeZeroPaymentReason, normalizePricingGenderInput, resolvePricingGender, resolvePricingPhase, resolvePricingPreviewGender, sumCheckoutItemTotals } from '@/lib/checkout/pricing';
import { resolveTicketPresentationMode } from '@/lib/checkout/ticket-presentation';
import {
  applyPricingResultsByClientId,
  computeSyncedItems,
  createCheckoutItem,
  type CheckoutItemConfig,
  type CheckoutItemPricingResult,
} from '@/lib/checkout/checkout-items';
import { getStatusLabel } from '@/lib/status-labels';
import { StoreCart } from '@/components/store/StoreCart';
import type { StoreItemForPurchase } from '@/lib/store/get-store-items';
import { CartStep } from './cart-step';

type EventData = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  banner_hero_url: string | null;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  registration_enabled: boolean;
  registration_open_at: string | null;
  registration_close_at: string | null;
  shirt_order_deadline: string | null;
  limit_shirt_selection_to_stock: boolean;
  kit_enabled: boolean;
  min_age: number;
  payment_pix_enabled: boolean;
  payment_credit_card_single_enabled: boolean;
  payment_credit_card_installments_enabled: boolean;
};

type CheckoutPaymentMethod = 'pix' | 'credit_card_single' | 'credit_card_installments';

type Category = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  capacity: number | null;
  available_slots: number | null;
  is_active: boolean;
  sort_order: number;
  current_batch_name: string | null;
  current_male_price: number | null;
  current_female_price: number | null;
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
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
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
  storeItems: StoreItemForPurchase[];
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

// Fonte canonica: mesmo shape devolvido por getUnifiedOrderSnapshot
// (src/app/inscricao/actions.ts), que le get_cart_order_details -- o MESMO
// RPC ja usado pelo CartStep. `items` mistura ingresso e produto
// (discriminado por item_kind); nenhuma etapa depois do carrinho recalcula
// total ou monta uma segunda lista -- so exibe o que a fonte devolve.
type OrderSnapshotPayload = {
  order_id: string;
  order_number: string | null;
  order_status: string;
  event_id: string;
  event_name: string | null;
  base_amount: number;
  discount_amount: number;
  final_amount: number;
  applied_coupon_code: string | null;
  payment: {
    payment_id: string;
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
  items: Array<{
    order_item_id: string;
    item_kind: 'ticket' | 'product';
    status: string;
    quantity: number;
    unit_price: number;
    discount_amount: number;
    final_amount: number;
    item_position: number | null;
    category_name: string | null;
    batch_name: string | null;
    shirt_type: string | null;
    shirt_size: string | null;
    holder_full_name: string | null;
    participant_id: string | null;
    participant_name: string | null;
    ticket_id: string | null;
    ticket_status: string | null;
    ticket_token: string | null;
    ownership_status: string | null;
    titular_display: string;
    store_item_id: string | null;
    store_item_name: string | null;
    store_item_image_url: string | null;
    store_item_variant_id: string | null;
    variant_name: string | null;
    variant_value: string | null;
  }>;
};

type OrderLineItem = OrderSnapshotPayload['items'][number];

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
  base_amount: number;
  discount_amount: number;
  applied_coupon_code: string | null;
  items: OrderLineItem[];
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
  payment_method: CheckoutPaymentMethod;
  coupon_code: string;
  shirt_type: string;
  shirt_size: string;
  quantity: number;
  lgpd: boolean;
};

type KitSelectionsState = {
  shirtType: string;
  shirtSize: string;
};

const STORAGE_VERSION = 'v4';

function paymentMethodLabel(method: CheckoutPaymentMethod) {
  if (method === 'credit_card_single') return 'Credito a vista';
  if (method === 'credit_card_installments') return 'Credito parcelado';
  return 'PIX';
}

function sanitizePaymentMethod(method: string | null | undefined, event: EventData): CheckoutPaymentMethod {
  const normalized = String(method ?? '').trim();

  if (normalized === 'pix' && event.payment_pix_enabled) return 'pix';
  if (normalized === 'credit_card_single' && event.payment_credit_card_single_enabled) return 'credit_card_single';
  if (normalized === 'credit_card_installments' && event.payment_credit_card_installments_enabled) return 'credit_card_installments';
  if (normalized === 'credit_card') {
    if (event.payment_credit_card_single_enabled) return 'credit_card_single';
    if (event.payment_credit_card_installments_enabled) return 'credit_card_installments';
  }

  if (event.payment_pix_enabled) return 'pix';
  if (event.payment_credit_card_single_enabled) return 'credit_card_single';
  if (event.payment_credit_card_installments_enabled) return 'credit_card_installments';
  return 'pix';
}

// Extraida do useState inicial de `form` pra ser reutilizada por
// restartWizard -- iniciar um checkout novo precisa recriar exatamente o
// mesmo estado de montagem original, nunca so limpar o sessionStorage
// deixando o form (e o resto do estado em memoria) intactos.
function buildInitialForm(initialBuyer: WizardProps['initialBuyer'], categories: Category[], event: EventData): FormState {
  return {
    full_name: initialBuyer.full_name || '',
    cpf: initialBuyer.cpf ? formatCpf(initialBuyer.cpf) : '',
    birth_date: initialBuyer.birth_date ? formatISOToDateBR(initialBuyer.birth_date) : '',
    gender: initialBuyer.gender || '',
    phone: initialBuyer.phone ? formatPhone(initialBuyer.phone) : '',
    email: initialBuyer.email || '',
    city: initialBuyer.city || '',
    category_id: (() => {
      const eligible = categories.filter((category) => category.is_active && (category.available_slots === null || category.available_slots > 0) && category.current_batch_name !== null);
      return eligible.length === 1 ? eligible[0].id : '';
    })(),
    payment_method: sanitizePaymentMethod('pix', event),
    coupon_code: '',
    shirt_type: '',
    shirt_size: '',
    quantity: 1,
    lgpd: Boolean(initialBuyer.privacy_policy_accepted),
  };
}

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function categoryPriceLabel(category: Category) {
  const prices = [category.current_male_price, category.current_female_price].filter((value): value is number => value !== null);
  if (prices.length === 0) return 'Preço a definir';
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  return min === max ? money(min) : `a partir de ${money(min)}`;
}

function deadlineText(value: string | null) {
  if (!value) return 'sem prazo';
  return formatDateTimeBR(value, ' às ');
}

function ticketLines(items: OrderLineItem[]) {
  return items.filter((item) => item.item_kind === 'ticket');
}

function productLines(items: OrderLineItem[]) {
  return items.filter((item) => item.item_kind === 'product');
}

/**
 * "2 ingressos · 3 produtos" em vez de um numero ambiguo de "itens" -- um
 * ingresso e sempre 1 linha (quantity=1), produto e a soma das quantidades
 * das linhas (uma linha "3x Copo" conta como 3, nao 1).
 */
function orderItemsLabel(items: OrderLineItem[]) {
  const ticketCount = ticketLines(items).length;
  const productCount = productLines(items).reduce((sum, item) => sum + item.quantity, 0);
  const parts = [
    ticketCount > 0 ? `${ticketCount} ingresso${ticketCount === 1 ? '' : 's'}` : null,
    productCount > 0 ? `${productCount} produto${productCount === 1 ? '' : 's'}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : '0 itens';
}

function shirtAvailabilityText(availableStock: number, enforcePhysicalStock: boolean) {
  if (!enforcePhysicalStock) return 'Disponivel para encomenda';
  if (availableStock <= 0) return 'Esgotado';
  if (availableStock === 1) return 'Resta apenas 1 unidade';
  if (availableStock <= 5) return `Restam apenas ${availableStock} unidades`;
  return 'Disponivel';
}

export function RegistrationWizard({
  event,
  isOpen,
  categories,
  benefitsByCategory,
  kitItems,
  inventory,
  initialBuyer,
  storeItems,
}: WizardProps) {
  const canSimulatePayment = process.env.NODE_ENV === 'development';
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [step, setStep] = useState(1);
  const [maxUnlockedStep, setMaxUnlockedStep] = useState(1);
  const [liveMessage, setLiveMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [form, setForm] = useState<FormState>(() => buildInitialForm(initialBuyer, categories, event));
  const [pricing, setPricing] = useState<PricingState | null>(null);
  const [registration, setRegistration] = useState<RegistrationSnapshot | null>(null);
  const [cartOrder, setCartOrder] = useState<{ orderId: string } | null>(null);
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
  const [checkoutItems, setCheckoutItems] = useState<CheckoutItemConfig[]>([
    createCheckoutItem(0, normalizePricingGenderInput(initialBuyer.gender)),
  ]);
  // Espelha checkoutItems sem entrar em nenhuma dependencia de effect/callback:
  // syncItemCount precisa do valor mais recente para calcular o array
  // sincronizado, mas nao pode ter sua identidade presa a checkoutItems (ver
  // comentario em syncItemCount). Atualizado num effect (nao durante o render)
  // porque mutar ref.current durante o render e proibido pelas regras de hooks.
  const checkoutItemsRef = useRef(checkoutItems);
  useEffect(() => {
    checkoutItemsRef.current = checkoutItems;
  }, [checkoutItems]);
  const [isRepricingItems, setIsRepricingItems] = useState(false);
  // null = ainda nao verificado. So sabemos com certeza depois da checagem
  // canonica no backend; ate la, "Este ingresso e para mim" fica bloqueado por
  // seguranca (nunca assume disponibilidade sem checar).
  const [buyerAlreadyHoldsActiveTicket, setBuyerAlreadyHoldsActiveTicket] = useState<boolean | null>(null);

  const topRef = useRef<HTMLHeadingElement | null>(null);

  const activeCategories = useMemo(
    () => categories.filter((category) => category.is_active && (category.available_slots === null || category.available_slots > 0) && category.current_batch_name !== null),
    [categories],
  );
  const categoryConfigurationKey = useMemo(
    () => activeCategories.map((category) => `${category.id}:${category.current_batch_name}:${category.available_slots ?? 'unlimited'}`).join('|'),
    [activeCategories],
  );

  const activeKitItems = useMemo(() => kitItems.filter((item) => item.is_active), [kitItems]);

  const availablePaymentMethods = useMemo<CheckoutPaymentMethod[]>(() => {
    const methods: CheckoutPaymentMethod[] = [];
    if (event.payment_pix_enabled) methods.push('pix');
    if (event.payment_credit_card_single_enabled) methods.push('credit_card_single');
    if (event.payment_credit_card_installments_enabled) methods.push('credit_card_installments');
    return methods.length > 0 ? methods : ['pix'];
  }, [event.payment_pix_enabled, event.payment_credit_card_single_enabled, event.payment_credit_card_installments_enabled]);

  const activeShirtItems = useMemo(
    () => activeKitItems.filter((item) => item.item_type === 'shirt'),
    [activeKitItems],
  );

  const hasRequiredShirt = activeShirtItems.some((item) => item.is_required);
  const hasKitStep = activeKitItems.length > 0;
  const shouldShowItemConfiguration = hasKitStep || activeShirtItems.length > 0;
  const totalSteps = 4;

  const sizeAvailability = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of inventory) {
      const key = makeShirtInventoryKey(row.shirt_type, row.shirt_size);
      if (!key.startsWith('::')) {
        map.set(key, Number(row.available_quantity));
      }
    }
    return map;
  }, [inventory]);

  const variantsByType = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const row of inventory) {
      const normalizedType = normalizeShirtType(row.shirt_type);
      const normalizedSize = normalizeShirtSize(row.shirt_size);
      if (!normalizedType || !normalizedSize) continue;
      const list = map.get(normalizedType) ?? [];
      if (!list.includes(normalizedSize)) {
        list.push(normalizedSize);
      }
      map.set(normalizedType, list);
    }
    return map;
  }, [inventory]);

  const availableShirtTypes = useMemo(() => {
    return SHIRT_TYPES.filter((shirtType) => {
      const variants = variantsByType.get(shirtType) ?? [];
      return variants.length > 0;
    });
  }, [variantsByType]);

  const enforcePhysicalStock = Boolean(event.limit_shirt_selection_to_stock);

  const activeCheckoutItems = useMemo(() => checkoutItems.slice(0, form.quantity), [checkoutItems, form.quantity]);

  const storageKey = useMemo(() => `militrin:wizard:${event.id}:${STORAGE_VERSION}`, [event.id]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.sessionStorage.setItem('militrin:last-wizard-next', `/inscricao/${event.slug}`);
  }, [event.slug]);

  // Retorna o array sincronizado (nao so grava no estado): quem chama e precisa
  // repassar o resultado ao pipeline de precificacao no mesmo instante (evitando
  // ler checkoutItems por closure, que ainda estaria desatualizado ate o proximo
  // render) usa o valor de retorno como itemsOverride.
  //
  // Le checkoutItemsRef (nao o state checkoutItems) de proposito: esta funcao e
  // dependencia do effect de hidratacao do sessionStorage (linha ~511). Se
  // checkoutItems entrasse nas deps deste useCallback, TODA vez que o preco
  // fosse aplicado (setCheckoutItems dentro de refreshItemPricingByCoupon) essa
  // funcao ganharia uma identidade nova, o que reacionava o effect de
  // hidratacao -- que le o sessionStorage de UMA renderizacao atras (o
  // proprio effect de persistencia, que escreve o snapshot atual, roda DEPOIS
  // dele na mesma leva de effects) e reaplica esse snapshot desatualizado,
  // apagando o preco/erro que acabara de chegar. Essa era a causa raiz real do
  // checkout travando em "Calculando preço..." indefinidamente: nao faltava a
  // resposta do RPC, ela chegava e era silenciosamente sobrescrita por este
  // loop de re-hidratacao a cada render.
  const syncItemCount = useCallback((targetQuantity: number, seedItems?: CheckoutItemConfig[]): CheckoutItemConfig[] => {
    const source = seedItems && seedItems.length > 0 ? seedItems : checkoutItemsRef.current;
    const next = computeSyncedItems(targetQuantity, source, normalizePricingGenderInput(form.gender), buyerAlreadyHoldsActiveTicket === false);
    setCheckoutItems(next);
    return next;
  }, [form.gender, buyerAlreadyHoldsActiveTicket]);

  // Verifica, o quanto antes, se o comprador autenticado ja e titular de outro
  // ingresso ativo neste evento -- decide canonicamente (backend) se "Este
  // ingresso e para mim" pode aparecer disponivel, em vez de assumir que sim.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const result = await getPublicBuyerTicketHolderStatusAction(event.id);
      if (cancelled) return;
      const alreadyHolds = result.success ? result.alreadyHoldsActiveTicket : true;
      setBuyerAlreadyHoldsActiveTicket(alreadyHolds);
      if (alreadyHolds) {
        setCheckoutItems((prev) => prev.map((item) => (
          item.ownershipMode === 'self' ? { ...item, ownershipMode: 'unassigned' } : item
        )));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [event.id]);

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
        checkoutItems?: CheckoutItemConfig[];
        pricing: PricingState | null;
        registration: RegistrationSnapshot | null;
        categoryConfigurationKey?: string;
      };
      window.setTimeout(() => {
        if (parsed.form) {
          const restoredQuantity = Math.max(1, Math.min(10, Number(parsed.form.quantity || 1)));
          setForm({
            ...parsed.form,
            category_id: activeCategories.length === 1
              ? activeCategories[0].id
              : activeCategories.some((category) => category.id === parsed.form.category_id) && activeCategories.length >= 2
                ? parsed.form.category_id
                : '',
            payment_method: sanitizePaymentMethod(parsed.form.payment_method, event),
            quantity: restoredQuantity,
          });
          syncItemCount(restoredQuantity, parsed.checkoutItems);
        }
        const restoredShirtType = parsed.shirtType ?? parsed.form?.shirt_type ?? '';
        const restoredShirtSize = parsed.shirtSize ?? parsed.form?.shirt_size ?? '';
        setShirtType(restoredShirtType);
        setShirtSize(restoredShirtSize);
        setKitSelections(parsed.kitSelections ?? { shirtType: restoredShirtType, shirtSize: restoredShirtSize });

        const persistedOrderId = parsed.registration?.order_id || null;

        if (!persistedOrderId) {
          // Nenhum pedido foi criado na sessao anterior (comprador ainda
          // configurando ingresso/dados) -- so config de rascunho, sem risco
          // de reaproveitar carrinho de outro pedido/comprador.
          if (parsed.step) setStep(Math.min(totalSteps, Math.max(1, parsed.step)));
          if (parsed.maxUnlockedStep) setMaxUnlockedStep(Math.min(totalSteps, Math.max(1, parsed.maxUnlockedStep)));
          if (parsed.pricing && parsed.categoryConfigurationKey === categoryConfigurationKey) setPricing(parsed.pricing);
          else setPricing(null);
          return;
        }

        // Um order_id existia na sessao anterior -- NUNCA restaurar so por
        // estar no cache local. O cache nao e fonte de verdade: o status
        // pode ter mudado via webhook (PIX pago) desde a ultima visita, e o
        // sessionStorage nao tem vinculo nenhum com QUAL comprador esta
        // logado agora neste navegador (troca de conta no mesmo browser
        // reaproveitaria o order_id de outra pessoa se restaurassemos cego).
        // Revalida no backend e so trata como "carrinho atual" retomavel se
        // o pedido ainda estiver pendente E dentro da janela de reserva --
        // qualquer outro caso (pago, confirmado, cancelado, expirado, nao
        // encontrado ou sem acesso) descarta o cache e comeca um contexto
        // novo, exatamente como uma nova compra deve comecar.
        void (async () => {
          const fresh = await getPublicOrderSnapshotAction(persistedOrderId);
          const payment = fresh.success ? fresh.snapshot.payment : null;
          const stillEditable = Boolean(
            fresh.success
            && fresh.snapshot.order_status === 'pending'
            && payment?.payment_status === 'pending'
            && (!payment?.expires_at || new Date(payment.expires_at).getTime() > Date.now()),
          );

          if (!stillEditable || !fresh.success) {
            sessionStorage.removeItem(storageKey);
            return;
          }

          setRegistration(mapOrderToRegistration(fresh.snapshot as OrderSnapshotPayload));
          if (parsed.step) setStep(Math.min(totalSteps, Math.max(1, parsed.step)));
          if (parsed.maxUnlockedStep) setMaxUnlockedStep(Math.min(totalSteps, Math.max(1, parsed.maxUnlockedStep)));
        })();
      }, 0);
    } catch {
      sessionStorage.removeItem(storageKey);
    }
    // mapOrderToRegistration nao entra nas deps de proposito: le closures
    // (form/pricing/event) so como fallback quando a fonte canonica
    // (fresh.order) nao tras o dado, e nao e memoizada -- adiciona-la aqui
    // recriaria o effect a cada render e refaria o fetch de validacao do
    // pedido persistido repetidamente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCategories, categoryConfigurationKey, event, storageKey, syncItemCount, totalSteps]);

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
        checkoutItems,
        pricing,
        registration,
        categoryConfigurationKey,
      }),
    );
  }, [categoryConfigurationKey, form, shirtType, shirtSize, kitSelections, checkoutItems, pricing, registration, step, maxUnlockedStep, storageKey]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setTimeTick(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    topRef.current?.focus();
  }, [step]);

  function updateCheckoutItem(index: number, patch: Partial<CheckoutItemConfig>) {
    setCheckoutItems((prev) => {
      const next = [...prev];
      const current = next[index] ?? createCheckoutItem(index, normalizePricingGenderInput(form.gender));
      const merged = { ...current, ...patch } as CheckoutItemConfig;

      if (merged.ownershipMode === 'self') {
        for (let i = 0; i < next.length; i += 1) {
          if (i !== index && next[i]?.ownershipMode === 'self') {
            next[i] = { ...next[i], ownershipMode: 'unassigned' };
          }
        }
      }

      next[index] = merged;
      return next;
    });
  }

  const countdownSeconds = (() => {
    if (!registration?.payment?.expires_at || registration.payment.payment_status !== 'pending') {
      return null;
    }
    const seconds = Math.floor((new Date(registration.payment.expires_at).getTime() - timeTick) / 1000);
    return seconds > 0 ? seconds : 0;
  })();

  const ariaLiveMessage = errors.length > 0 ? errors[0] : liveMessage;

  const categorySelectionRequired = activeCategories.length >= 2;
  const selectedCategory = activeCategories.length === 1
    ? activeCategories[0]
    : activeCategories.find((cat) => cat.id === form.category_id) || null;
  const effectiveCategoryId = selectedCategory?.id ?? null;
  const categoryChoiceReady = !categorySelectionRequired || Boolean(effectiveCategoryId);
  const ticketTypeLabel = selectedCategory?.name || 'Ingresso único';

  // O RPC de preview exige genero valido mesmo quando o preco da categoria
  // nao varia por genero. hasResolvableGender reflete o genero JA conhecido
  // (perfil do comprador ou item ja configurado); genderIndependentPriceAvailable
  // reflete o caso em que a pergunta nem importa (male_price === female_price,
  // dado ja exposto na propria lista de categorias antes de qualquer selecao).
  // canAttemptPricing so fica false quando nenhuma das duas se aplica -- nesse
  // caso a Etapa 1 nao pode mostrar preco ainda (pending_input legitimo: falta
  // uma escolha do comprador), e tentar o RPC so produziria um erro previsivel
  // ("Genero invalido...") por uma informacao que sera coletada mais adiante.
  const hasResolvableGender = checkoutItems.some((item) => Boolean(resolvePricingGender({
    itemGender: item.pricingGender,
    requestGender: form.gender,
    buyerGender: form.gender,
  })));
  const genderIndependentPriceAvailable = Boolean(
    selectedCategory
    && selectedCategory.current_male_price != null
    && selectedCategory.current_female_price != null
    && Number(selectedCategory.current_male_price) === Number(selectedCategory.current_female_price),
  );
  const canAttemptPricing = categoryChoiceReady && (hasResolvableGender || genderIndependentPriceAvailable);

  const stepShown = step;

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
    const next = Math.min(totalSteps, Math.max(1, target));
    if (next > maxUnlockedStep) return;
    setStep(next);
    setErrors([]);
  }

  function unlockAndGoTo(target: number) {
    const normalized = Math.min(totalSteps, Math.max(1, target));
    setMaxUnlockedStep((prev) => Math.max(prev, normalized));
    setStep(normalized);
    setErrors([]);
  }

  function canBack() {
    return step > 1 && !submitting;
  }

  function onBack() {
    if (!canBack()) return;
    if (step === totalSteps && registration?.payment.payment_status === 'paid') return;
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

    if (field === 'gender') {
      const resolvedGender = normalizePricingGenderInput(value);
      if (!resolvedGender) return;

      setCheckoutItems((prev) => {
        if (prev.length !== 1) return prev;
        const first = prev[0];
        if (!first || first.pricingGender === resolvedGender) return prev;
        return [{ ...first, pricingGender: resolvedGender }];
      });
    }
  }

  function mapOrderToRegistration(order: OrderSnapshotPayload): RegistrationSnapshot {
    const items = Array.isArray(order?.items) ? order.items : [];
    // Fonte ja ordena ingresso antes de produto (ver ORDER BY em
    // get_cart_order_details), entao o primeiro ingresso e sempre items[0]
    // quando existe ao menos 1 -- mas busca explicita por item_kind aqui
    // pra nunca depender silenciosamente dessa ordem.
    const firstTicket = items.find((item) => item.item_kind === 'ticket') ?? null;
    const paid = order?.payment?.payment_status === 'paid';

    return {
      participant_id: firstTicket?.participant_id || firstTicket?.order_item_id || order.order_id,
      payment_id: order?.payment?.payment_id || '',
      final_amount: Number(order?.payment?.final_amount ?? 0),
      payment_status: String(order?.payment?.payment_status ?? 'pending'),
      expires_at: order?.payment?.expires_at || null,
      event_id: String(order?.event_id ?? event.id),
      event_name: order?.event_name || event.name,
      participant_name: firstTicket?.participant_name || form.full_name,
      category_name: firstTicket?.category_name || ticketTypeLabel,
      batch_name: firstTicket?.batch_name || pricing?.batch_name || null,
      reservation_status: String(order?.order_status ?? 'pending'),
      reservation_expires_at: order?.payment?.expires_at || null,
      shirt_type: firstTicket?.shirt_type || form.shirt_type || null,
      shirt_size: firstTicket?.shirt_size || form.shirt_size || null,
      payment: {
        payment_id: order?.payment?.payment_id || '',
        participant_id: firstTicket?.participant_id || firstTicket?.order_item_id || order.order_id,
        event_id: String(order?.event_id ?? event.id),
        event_name: order?.event_name || event.name,
        amount: Number(order?.payment?.amount ?? 0),
        discount_amount: Number(order?.payment?.discount_amount ?? 0),
        final_amount: Number(order?.payment?.final_amount ?? 0),
        payment_method: order?.payment?.payment_method || form.payment_method,
        payment_status: String(order?.payment?.payment_status ?? 'pending'),
        pix_code: order?.payment?.pix_code || null,
        pix_qrcode: order?.payment?.pix_qrcode || null,
        gateway_payment_id: order?.payment?.gateway_payment_id || null,
        expires_at: order?.payment?.expires_at || null,
        paid_at: order?.payment?.paid_at || (paid ? new Date().toISOString() : null),
      },
      kit_items: [],
      qr_token: firstTicket?.ticket_token || null,
      order_id: order.order_id,
      order_number: order.order_number || null,
      base_amount: Number(order?.base_amount ?? 0),
      discount_amount: Number(order?.discount_amount ?? 0),
      applied_coupon_code: order?.applied_coupon_code || null,
      items,
    };
  }

  function getSizeOptionsForType(shirtTypeValue: string, itemIndex: number) {
    const normalizedType = normalizeShirtType(shirtTypeValue);
    if (!normalizedType) return [];
    const baseOptions = variantsByType.get(normalizedType) ?? [];
    return baseOptions.filter((size) => {
      if (!enforcePhysicalStock) return true;
      const key = makeShirtInventoryKey(normalizedType, size);
      const physical = Number(sizeAvailability.get(key) ?? 0);
      const demandFromOtherItems = activeCheckoutItems.reduce((count, checkoutItem, checkoutIndex) => {
        if (checkoutIndex === itemIndex) return count;
        if (normalizeShirtType(checkoutItem.shirtType) === normalizedType && normalizeShirtSize(checkoutItem.shirtSize) === size) {
          return count + 1;
        }
        return count;
      }, 0);

      const available = physical - demandFromOtherItems;
      const isCurrentSelection = normalizeShirtType(activeCheckoutItems[itemIndex]?.shirtType) === normalizedType
        && normalizeShirtSize(activeCheckoutItems[itemIndex]?.shirtSize) === size;

      return available > 0 || isCurrentSelection;
    });
  }

  function getEffectiveStockForItemVariant(itemIndex: number, shirtTypeValue: string, shirtSizeValue: string) {
    const key = makeShirtInventoryKey(shirtTypeValue, shirtSizeValue);
    const physical = Number(sizeAvailability.get(key) ?? 0);
    const normalizedType = normalizeShirtType(shirtTypeValue);
    const normalizedSize = normalizeShirtSize(shirtSizeValue);
    const demandFromOtherItems = activeCheckoutItems.reduce((count, checkoutItem, checkoutIndex) => {
      if (checkoutIndex === itemIndex) return count;
      if (normalizeShirtType(checkoutItem.shirtType) === normalizedType && normalizeShirtSize(checkoutItem.shirtSize) === normalizedSize) {
        return count + 1;
      }
      return count;
    }, 0);

    return physical - demandFromOtherItems;
  }

  async function refreshItemPricingByCoupon(couponCode?: string, itemsOverride?: CheckoutItemConfig[]) {
    const itemsToPrice = itemsOverride ?? checkoutItems;
    if (!canAttemptPricing || itemsToPrice.length === 0) return;

    setIsRepricingItems(true);
    try {
      const pricingResults = await Promise.all(
        itemsToPrice.map(async (item) => {
          // resolvePricingPreviewGender (nao resolvePricingGender puro): quando o
          // preco da categoria nao varia por genero, usa 'male' so para satisfazer
          // o contrato do RPC (que sempre exige um token valido) sem esperar o
          // comprador declarar o genero real -- ver doc da funcao. O genero
          // efetivamente declarado pelo comprador (item.pricingGender/form.gender)
          // nunca e alterado por isso; a validacao final do pedido continua exigindo
          // o genero real via resolvePricingGender em handleCreateAndContinuePayment.
          const resolvedGender = resolvePricingPreviewGender(
            {
              itemGender: item.pricingGender,
              requestGender: form.gender,
              buyerGender: form.gender,
            },
            { malePrice: selectedCategory?.current_male_price, femalePrice: selectedCategory?.current_female_price },
          );

          const result = await getPublicPricingPreviewAction({
            event_id: event.id,
            ticket_category_id: effectiveCategoryId,
            gender: resolvedGender ?? '',
            coupon_code: couponCode?.trim() ? couponCode.trim() : undefined,
          });

          if (process.env.NODE_ENV !== 'production' && (!result.success || !('pricing' in result) || !result.pricing)) {
            console.error('[refreshItemPricingByCoupon] item sem preco', {
              clientId: item.clientId,
              code: 'code' in result ? result.code : null,
              message: 'message' in result ? result.message : null,
            });
          }

          return { clientId: item.clientId, result: result as CheckoutItemPricingResult };
        }),
      );

      // Casar por clientId, nunca por indice posicional: itemsToPrice e o
      // checkoutItems mais recente podem divergir em tamanho/ordem se outro
      // evento (mudanca de quantidade, edicao de item) correu entre o disparo
      // e a resposta. Por indice, um item novo herdaria o resultado de outro
      // ou ficaria sem par e cairia num erro artificial (nunca fabricado pelo
      // backend) -- foi exatamente essa desalinhamento que zerava o 2o ingresso.
      const resultsByClientId = new Map(pricingResults.map((entry) => [entry.clientId, entry.result]));

      setCheckoutItems((prev) => applyPricingResultsByClientId(prev, resultsByClientId));

      const firstValidResult = pricingResults.map((entry) => entry.result).find((result) => result.success);
      if (firstValidResult && firstValidResult.success) {
        setPricing(firstValidResult.pricing as PricingState);
      }
    } finally {
      setIsRepricingItems(false);
    }
  }

  // Assim que a opcao de ingresso estiver resolvida (0 categorias: imediato;
  // 1 categoria: auto-selecionada; 2+: apos a escolha) E for possivel calcular
  // o preco (genero ja conhecido OU preco da categoria nao varia por genero),
  // busca o preco canonico do backend para a Etapa 1 exibir valor real em vez
  // de R$ 0,00 provisorio. Se canAttemptPricing ainda for false neste momento
  // (preco realmente depende de um genero que so sera declarado mais adiante),
  // nao tenta -- outros pontos ja disparam o fetch assim que o genero for
  // resolvido (o seletor de genero por item na propria Etapa 1, quando exibido,
  // e handlePersonalNext ao avancar da Etapa 2). effectiveCategoryId/
  // categoryChoiceReady ficam como deps (nao canAttemptPricing) de proposito:
  // o objetivo e reagir a mudanca da opcao de ingresso, nao a cada tecla ou a
  // cada resposta do proprio fetch -- isso duplicaria o fetch que os outros
  // pontos ja disparam quando o genero se resolve.
  useEffect(() => {
    if (!categoryChoiceReady || !canAttemptPricing) return;
    const couponCode = form.coupon_code || undefined;
    const timer = window.setTimeout(() => {
      void refreshItemPricingByCoupon(couponCode);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveCategoryId, categoryChoiceReady]);

  function validateCheckoutItems() {
    const visibleItems = checkoutItems.slice(0, form.quantity);
    const allErrors: string[] = [];

    const stockDemand = new Map<string, number>();
    visibleItems.forEach((item) => {
      if (!item.shirtType || !item.shirtSize) return;
      const key = `${item.shirtType}::${item.shirtSize}`;
      stockDemand.set(key, (stockDemand.get(key) ?? 0) + 1);
    });

    const outOfStockKeys = new Set<string>();
    if (enforcePhysicalStock) {
      stockDemand.forEach((requested, key) => {
        const available = Number(sizeAvailability.get(key) ?? 0);
        if (requested > available) {
          outOfStockKeys.add(key);
        }
      });
    }

    setCheckoutItems((prev) =>
      prev.map((item, index) => {
        if (index >= form.quantity) return item;

        const itemErrors: string[] = [];
        // Um preco que falhou ao calcular nunca pode ser tratado como R$ 0,00:
        // bloqueia o avanco ate que a precificacao seja recalculada com sucesso.
        if (item.pricingError) itemErrors.push(item.pricingError);
        if (shouldShowItemConfiguration && !item.pricingGender) itemErrors.push('Selecione genero.');
        if (shouldShowItemConfiguration && item.ownershipMode === 'named' && !item.holder_full_name.trim()) itemErrors.push('Informe o titular.');
        if (shouldShowItemConfiguration && hasRequiredShirt) {
          if (!item.shirtType) itemErrors.push('Selecione modelo da camiseta.');
          if (!item.shirtSize) itemErrors.push('Selecione tamanho da camiseta.');
        }

        const stockKey = `${item.shirtType}::${item.shirtSize}`;
        if (item.shirtType && item.shirtSize && outOfStockKeys.has(stockKey)) {
          itemErrors.push('Nao ha unidades suficientes deste tamanho para todos os ingressos selecionados.');
        }

        allErrors.push(...itemErrors.map((message) => `Ingresso ${index + 1}: ${message}`));

        const resolvedGender = item.pricingGender ?? normalizePricingGenderInput(form.gender);

        return {
          ...item,
          pricingGender: resolvedGender,
          validationErrors: itemErrors,
          visualStatus: item.pricingError
            ? 'pricing_error'
            : itemErrors.length > 0
              ? (itemErrors.some((msg) => msg.includes('estoque')) ? 'out_of_stock' : 'missing')
              : 'complete',
        };
      }),
    );

    return allErrors;
  }

  function selectCategory(categoryId: string) {
    setField('category_id', categoryId);
    setErrors([]);
    // Nunca deixar o preco da categoria anterior visivel enquanto recalcula:
    // o effect de bootstrap de precificacao reage a mudanca de effectiveCategoryId
    // e busca o preco da categoria nova assim que ela for resolvida.
    setPricing(null);
    syncItemCount(form.quantity);
    setLiveMessage('Categoria selecionada. Calculando preço...');
  }

  function handleChooseTicketNext() {
    if (categorySelectionRequired && !effectiveCategoryId) {
      setErrors(['Selecione uma categoria para continuar.']);
      return;
    }

    if (effectiveCategoryId && !activeCategories.some((item) => item.id === effectiveCategoryId)) {
      setErrors(['A categoria escolhida não está disponível.']);
      return;
    }

    const itemErrors = validateCheckoutItems();
    if (itemErrors.length > 0) {
      setErrors(itemErrors);
      return;
    }

    unlockAndGoTo(2);
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
    if (!categoryChoiceReady) nextErrors.push('Selecione uma categoria antes de avançar.');

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
      const preview = await getPublicPricingPreviewAction({
        event_id: event.id,
        ticket_category_id: effectiveCategoryId,
        gender: form.gender,
        coupon_code: form.coupon_code || undefined,
      });

      if (!preview.success || !('pricing' in preview)) {
        setErrors([('message' in preview && preview.message) || 'Não foi possível atualizar o preço.']);
        return;
      }

      setPricing(preview.pricing as PricingState);
      const syncedItems = syncItemCount(form.quantity);
      await refreshItemPricingByCoupon(form.coupon_code || undefined, syncedItems);
      setLiveMessage('Seus dados foram carregados da sua conta e o valor foi recalculado.');
      unlockAndGoTo(3);
    });
  }

  async function handleCreateAndContinuePayment() {
    if (submitting || submitLockRef.current) return;
    submitLockRef.current = true;
    setSubmitting(true);
    setErrors([]);

    const validationErrors = validateCheckoutItems();
    const localItems = checkoutItems.slice(0, form.quantity);

    if (validationErrors.length > 0) {
      setSubmitting(false);
      submitLockRef.current = false;
      setErrors(validationErrors);
      return;
    }

    const requestId = `${event.id}:${effectiveCategoryId ?? 'single'}:${removeCpfMask(form.cpf)}:${form.quantity}:${Date.now()}`;

    const resolvedRequestGender = resolvePricingGender({
      itemGender: localItems[0]?.pricingGender,
      requestGender: form.gender,
      buyerGender: form.gender,
    });

    if (!resolvedRequestGender) {
      setSubmitting(false);
      submitLockRef.current = false;
      setErrors(['Selecione Feminino ou Masculino para o primeiro ingresso antes de continuar.']);
      return;
    }

    const payload = {
      event_id: event.id,
      ticket_category_id: effectiveCategoryId,
      quantity: form.quantity,
      gender: resolvedRequestGender,
      payment_method: form.payment_method,
      coupon_code: form.coupon_code || undefined,
      notes: 'Portal público de inscrição',
      client_request_id: requestId,
      assign_first_to_buyer: true,
      items: localItems.map((item) => {
        const ownershipStatus: 'assigned' | 'unassigned' = item.ownershipMode === 'self' ? 'assigned' : 'unassigned';
        return {
          pricing_gender: item.pricingGender ?? undefined,
          shirt_type: item.shirtType || undefined,
          shirt_size: item.shirtSize || undefined,
          ownership_mode: item.ownershipMode,
          ownership_status: ownershipStatus,
          holder_full_name: item.ownershipMode === 'named' ? item.holder_full_name : undefined,
          holder_cpf: item.ownershipMode === 'named' ? removeCpfMask(item.holder_cpf) : undefined,
          holder_email: item.ownershipMode === 'named' ? item.holder_email : undefined,
          holder_phone: item.ownershipMode === 'named' ? item.holder_phone : undefined,
        };
      }),
      buyer: {
        full_name: form.full_name,
        cpf: removeCpfMask(form.cpf),
        birth_date: form.birth_date,
        gender: form.gender,
        phone: form.phone,
        email: form.email,
        city: form.city,
      },
    } as const;

    const inventoryAdjustments = payload.items.reduce<Record<string, number>>((acc, item) => {
      const shirtType = typeof item.shirt_type === 'string' ? item.shirt_type.trim() : '';
      const shirtSize = typeof item.shirt_size === 'string' ? item.shirt_size.trim() : '';
      if (!shirtType || !shirtSize) return acc;
      const key = `${shirtType}::${shirtSize}`;
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});

    console.info('[checkout:create-order] server-action-payload', {
      participant: {
        full_name: payload.buyer.full_name,
        cpf_masked: payload.buyer.cpf.replace(/\D/g, '').replace(/.(?=.{3})/g, '*'),
        birth_date: payload.buyer.birth_date,
        gender: payload.buyer.gender,
        phone: payload.buyer.phone,
        email: payload.buyer.email,
        city: payload.buyer.city,
      },
      order: {
        event_id: payload.event_id,
        ticket_category_id: payload.ticket_category_id,
        quantity: payload.quantity,
        payment_method: payload.payment_method,
        coupon_code: payload.coupon_code ?? null,
        client_request_id: payload.client_request_id,
        notes: payload.notes,
      },
      order_items: payload.items,
      reservations: {
        expected_item_reservations: payload.quantity,
        assign_first_to_buyer: payload.assign_first_to_buyer,
      },
      inventory_adjustments: Object.entries(inventoryAdjustments).map(([key, requested_quantity]) => {
        const [shirt_type, shirt_size] = key.split('::');
        return { shirt_type, shirt_size, requested_quantity };
      }),
      server_action_payload: {
        action_name: 'createPublicMultiOrderAction',
        payload,
      },
    });

    let result: Awaited<ReturnType<typeof createPublicMultiOrderAction>>;
    try {
      result = await createPublicMultiOrderAction(payload);
    } finally {
      setSubmitting(false);
      submitLockRef.current = false;
    }

    if (!result.success || !('order' in result)) {
      setErrors([('message' in result && result.message) || 'Não foi possível criar sua inscrição.']);
      return;
    }

    const createdOrder = result.order;
    if (!createdOrder) {
      setErrors(['Nao foi possivel carregar os dados do pedido criado.']);
      return;
    }

    // Pedido criado (sem cupom e sem pagamento finalizado ainda) -- entra na
    // etapa Carrinho. A confirmacao real (cupom ja recalculado no backend,
    // PIX, avanco automatico se ficar R$0) so acontece em
    // handleCartFinalized, depois que o comprador clicar "Continuar para
    // pagamento" no carrinho.
    setLiveMessage('Pedido criado.');
    setCartOrder({ orderId: String(createdOrder.order_id ?? '') });
  }

  async function handleCartFinalized(order: OrderSnapshotPayload) {
    const createdRegistration = mapOrderToRegistration(order);
    setRegistration(createdRegistration);
    const zeroPaymentReason = describeZeroPaymentReason({
      baseAmount: createdRegistration.payment.amount,
      discountAmount: createdRegistration.payment.discount_amount,
      finalAmount: createdRegistration.payment.final_amount,
      paymentMethod: createdRegistration.payment.payment_method,
      couponApplied: createdRegistration.payment.discount_amount > 0,
    });
    setCourtesyMessage(zeroPaymentReason?.message ?? null);

    if ((createdRegistration.final_amount ?? 0) <= 0) {
      unlockAndGoTo(4);
      sessionStorage.removeItem(storageKey);
      return;
    }

    if (form.payment_method === 'pix') {
      const pix = await generatePublicOrderPixAction(createdRegistration.order_id || '');
      if (!pix.success) {
        setErrors([pix.message || 'Falha ao gerar PIX.']);
        return;
      }
      if (!pix.payment) {
        setErrors(['Falha ao gerar PIX.']);
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
  }

  async function handleSimulatePaid() {
    if (!registration) return;
    startTransition(async () => {
      const method = (form.payment_method === 'pix' ? 'pix' : 'credit_card') as 'pix' | 'credit_card';
      const paid = await simulatePublicOrderPaymentAction(registration.order_id || '', method);
      if (!paid.success || !('order' in paid)) {
        setErrors([('message' in paid && paid.message) || 'Não foi possível confirmar o pagamento.']);
        return;
      }
      setRegistration(mapOrderToRegistration(paid.order));
      setLiveMessage('Pagamento confirmado.');
      sessionStorage.removeItem(storageKey);
      unlockAndGoTo(4);
    });
  }

  function restartWizard() {
    // Antes so limpava sessionStorage e chamava router.refresh() -- que so
    // reexecuta Server Components, nunca remonta este client component nem
    // reseta seu estado em memoria. Resultado: "Nova inscricao" nao tirava o
    // comprador da tela de conclusao/pagamento do pedido ANTERIOR (registration/
    // cartOrder continuavam apontando pra ele), entao a proxima interacao
    // reaproveitava o pedido antigo. Precisa resetar cada state explicitamente
    // pra um checkout novo ter identidade propria de verdade.
    sessionStorage.removeItem(storageKey);
    setErrors([]);
    setLiveMessage('');
    setCourtesyMessage(null);
    setRegistration(null);
    setCartOrder(null);
    setPricing(null);
    setForm(buildInitialForm(initialBuyer, categories, event));
    setCheckoutItems([createCheckoutItem(0, normalizePricingGenderInput(initialBuyer.gender))]);
    setShirtType('');
    setShirtSize('');
    setKitSelections({ shirtType: '', shirtSize: '' });
    setMaxUnlockedStep(1);
    setStep(1);
    router.refresh();
  }

  const progress = (stepShown / totalSteps) * 100;
  const visibleTotalSteps = totalSteps;
  const trail = [
    { id: 1, label: 'Escolha seu ingresso' },
    { id: 2, label: 'Seus dados' },
    { id: 3, label: 'Pagamento' },
    { id: 4, label: 'Concluído' },
  ];

  const itemTotals = sumCheckoutItemTotals(activeCheckoutItems);
  const hasPricedCheckoutItems = activeCheckoutItems.some((item) => item.visualStatus === 'price_updated' || item.visualStatus === 'complete');
  const hasPricingErrorItems = activeCheckoutItems.some((item) => item.visualStatus === 'pricing_error');
  // 0 categorias elegiveis = evento realmente sem categoria: nunca existiu selecao
  // de lote para o usuario fazer, entao o rotulo correto e "Ingresso único", nunca
  // "Não selecionado". Enquanto o preco esta em transito (recalculando ou ainda nao
  // buscado), a fase fica "loading" mesmo que sobrem valores antigos em checkoutItems,
  // para nunca mostrar R$ 0,00 nem preco de outra categoria como se fosse definitivo.
  const ticketPresentationMode = resolveTicketPresentationMode(activeCategories.length);
  const isSingleTicketEvent = ticketPresentationMode === 'single';
  // Com exatamente 1 categoria ativa, ela continua sendo a fonte canonica de
  // preco no backend/order item, mas nao vale a pena expor como "escolha" ao
  // comprador: mostramos so o lote resolvido, sem repetir o nome da categoria.
  const shouldShowCategoryLabel = ticketPresentationMode === 'category_visible';
  const pricingPhase = resolvePricingPhase({
    canAttemptPricing,
    isRepricingItems,
    hasPricingErrorItems,
    hasPricedCheckoutItems,
  });
  // Mensagem exibida enquanto pricingPhase === 'pending_input': depende do que
  // falta -- escolher categoria (2+ categorias) ou informar genero (preco varia
  // por genero e ele ainda nao e conhecido). Nunca reaproveita o texto de
  // "Calculando preço...", que implica um fetch em andamento -- aqui nao ha
  // nenhum.
  const pendingInputMessage = !categoryChoiceReady
    ? 'Selecione uma categoria para ver o preço.'
    : 'Informe o gênero para calcularmos o preço deste ingresso.';
  const firstPricingErrorMessage = activeCheckoutItems.find((item) => item.pricingError)?.pricingError ?? 'Não foi possível calcular o preço.';
  const batchDisplayLabel = isSingleTicketEvent
    ? 'Ingresso único'
    : pricing?.batch_name || (pricingPhase === 'loading' ? 'Calculando...' : '-');
  const zeroPaymentSummaryReason = hasPricedCheckoutItems && !hasPricingErrorItems
    ? describeZeroPaymentReason({
        baseAmount: itemTotals.original,
        discountAmount: itemTotals.discount,
        finalAmount: itemTotals.total,
        couponApplied: Boolean(form.coupon_code.trim()),
      })
    : null;

  const groupedShirts = Array.from(
    activeCheckoutItems.reduce((map, item) => {
      if (!item.shirtType || !item.shirtSize) return map;
      const key = `${item.shirtType}::${item.shirtSize}`;
      map.set(key, (map.get(key) ?? 0) + 1);
      return map;
    }, new Map<string, number>()),
  );

  // Uma vez que o pedido existe (registration populado depois do carrinho,
  // em handleCartFinalized/handleSimulatePaid), o resumo lateral passa a
  // ler os totais canonicos do pedido (registration.base_amount/
  // discount_amount/payment.final_amount, vindos de get_cart_order_details)
  // em vez de itemTotals (somado a partir de checkoutItems, estado
  // client-side de configuracao de ingresso de ANTES do pedido existir --
  // nunca atualizado pelo que acontece dentro do CartStep). Sem isso o
  // resumo lateral ficava congelado no total so-ingresso pra sempre a
  // partir do carrinho em diante, mesmo com produto no pedido. Enquanto o
  // pedido nao existe (steps 1-2), nada muda aqui -- mesmo calculo de
  // sempre.
  const registrationProductLines = registration
    ? productLines(registration.items).map((item) => ({
        key: item.order_item_id,
        label: `${item.quantity}x ${item.store_item_name ?? 'Produto'}${item.variant_name ? ` (${item.variant_name} ${item.variant_value})` : ''}`,
      }))
    : [];

  // Mesmo raciocinio de registrationProductLines: uma vez que o pedido
  // existe, a config de camiseta por ingresso exibida aqui precisa vir de
  // registration.items (get_cart_order_details, a mesma fonte que o
  // CartStep usa pra montar "Seu carrinho"), nunca de checkoutItems --
  // senao os dois lados podem divergir sempre que o backend for a fonte
  // real da verdade (ex.: apos a correcao de create_multi_ticket_order_checkout_legacy,
  // que agora grava shirt_type/shirt_size por ingresso individualmente).
  const registrationGroupedShirts = registration
    ? Array.from(
        ticketLines(registration.items).reduce((map, item) => {
          if (!item.shirt_type || !item.shirt_size) return map;
          const key = `${item.shirt_type}::${item.shirt_size}`;
          map.set(key, (map.get(key) ?? 0) + 1);
          return map;
        }, new Map<string, number>()),
      )
    : groupedShirts;

  const summaryValues = registration
    ? {
        event: registration.event_name || event.name,
        category: registration.category_name || ticketTypeLabel,
        batch: registration.batch_name || batchDisplayLabel,
        quantity: ticketLines(registration.items).length,
        coupon: registration.applied_coupon_code || 'Não selecionado',
        original: money(registration.base_amount),
        discount: money(registration.discount_amount),
        total: money(registration.payment.final_amount),
        groupedShirts: registrationGroupedShirts,
        productLines: registrationProductLines,
      }
    : {
        event: event.name,
        category: ticketTypeLabel,
        batch: batchDisplayLabel,
        quantity: form.quantity,
        coupon: form.coupon_code || 'Não selecionado',
        original: money(itemTotals.original),
        discount: money(itemTotals.discount),
        total: money(itemTotals.total),
        groupedShirts,
        productLines: registrationProductLines,
      };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow),transparent_35%),linear-gradient(180deg,#020617,#0b1220)] px-4 py-5 text-slate-100 sm:px-6">
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

          {event.banner_hero_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.banner_hero_url} alt="" className="mt-4 h-40 w-full rounded-2xl object-cover sm:h-52" />
          ) : null}

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
                  {shouldShowCategoryLabel ? <p className="mt-2">Categoria: {summaryValues.category}</p> : null}
                  <p>Ingressos: {summaryValues.quantity}</p>
                  <p>{isSingleTicketEvent ? 'Ingresso' : 'Lote'}: {summaryValues.batch}</p>
                  {summaryValues.groupedShirts.map(([shirtKey, qty]) => (
                    <p key={`m-s-${shirtKey}`} className="text-xs text-slate-400">{qty}x {shirtKey.replace('::', ' / ')}</p>
                  ))}
                  {summaryValues.productLines.map((line) => (
                    <p key={`m-p-${line.key}`} className="text-xs text-slate-400">{line.label}</p>
                  ))}
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
                <h2 className="text-lg font-semibold">1. Escolha seu ingresso</h2>
                {categorySelectionRequired ? (
                  <p className="text-sm text-slate-300">Selecione o tipo de ingresso e configure os itens da compra.</p>
                ) : null}
                {categorySelectionRequired ? (
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
                            onChange={() => selectCategory(category.id)}
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
                              {category.current_batch_name ? `${category.current_batch_name} — ${categoryPriceLabel(category)}` : categoryPriceLabel(category)}
                            </span>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
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
                          {form.birth_date && (() => {
                            const ageAtEvent = calculateAgeAtEventDate(form.birth_date, event.starts_at);
                            const minAgeSatisfied = isMinimumAgeSatisfied(form.birth_date, event.starts_at, event.min_age);
                            if (event.min_age > 0 && minAgeSatisfied === null) {
                              return (
                                <span className="text-xs text-rose-400">
                                  Não foi possível confirmar a idade mínima porque a data do evento não está configurada.
                                </span>
                              );
                            }
                            if (ageAtEvent === null) return null;
                            return (
                              <span className={`text-xs ${minAgeSatisfied === false ? 'text-rose-400' : 'text-slate-400'}`}>
                                Idade na data do evento: {ageAtEvent} anos
                                {minAgeSatisfied === false
                                  ? ` — este evento exige idade mínima de ${event.min_age} anos na data do evento`
                                  : ''}
                              </span>
                            );
                          })()}
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

            {step === 1 && categoryChoiceReady && (
              <div className="space-y-4">
                {/* Preco e lote em destaque: o comprador ve o que importa primeiro. */}
                <div className="rounded-2xl border border-emerald-500/20 bg-slate-950 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      {shouldShowCategoryLabel ? <p className="text-xs uppercase tracking-wide text-slate-400">{ticketTypeLabel}</p> : null}
                      <p className="text-lg font-semibold text-slate-100">{isSingleTicketEvent ? 'Ingresso' : 'Lote'}: {batchDisplayLabel}</p>
                    </div>

                    <label className="flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-1.5 text-sm text-slate-200">
                      <span className="text-xs text-slate-400">Qtd.</span>
                      <input
                        type="number"
                        min={1}
                        max={10}
                        value={form.quantity}
                        onChange={async (event_) => {
                          const parsed = Number(event_.target.value || 1);
                          const nextQuantity = Math.max(1, Math.min(10, parsed));
                          if (nextQuantity < form.quantity) {
                            const removed = checkoutItems.slice(nextQuantity);
                            const hasFilled = removed.some((item) => {
                              return (
                                item.ownershipMode !== 'unassigned'
                                || item.holder_full_name.trim().length > 0
                                || item.shirtType.trim().length > 0
                                || item.shirtSize.trim().length > 0
                              );
                            });
                            if (hasFilled) {
                              const confirmed = window.confirm('Reduzir a quantidade removera ingressos ja preenchidos. Deseja continuar?');
                              if (!confirmed) return;
                            }
                          }
                          setField('quantity', nextQuantity);
                          const syncedItems = syncItemCount(nextQuantity);
                          await refreshItemPricingByCoupon(form.coupon_code || undefined, syncedItems);
                        }}
                        className="h-8 w-16 rounded-lg border border-slate-700 bg-slate-950 px-2 text-sm"
                      />
                    </label>
                  </div>

                  {pricingPhase === 'ready' ? (
                    <div className="mt-3">
                      <p className="text-3xl font-bold text-emerald-300">{summaryValues.total}</p>
                      {itemTotals.discount > 0 ? (
                        <p className="mt-1 text-xs text-slate-400">Valor base {summaryValues.original} · Desconto {summaryValues.discount}</p>
                      ) : null}
                      {zeroPaymentSummaryReason ? (
                        <p className="mt-1 text-xs text-emerald-200">{zeroPaymentSummaryReason.message}</p>
                      ) : null}
                    </div>
                  ) : pricingPhase === 'error' ? (
                    <p className="mt-3 text-xs text-rose-300" role="alert">
                      Não foi possível calcular o preço: {firstPricingErrorMessage} Corrija antes de continuar.
                    </p>
                  ) : pricingPhase === 'pending_input' ? (
                    <p className="mt-3 text-xs text-slate-400">{pendingInputMessage}</p>
                  ) : (
                    <p className="mt-3 flex items-center gap-2 text-xs text-slate-400" aria-live="polite">
                      <span className="h-3 w-3 animate-pulse rounded-full bg-slate-500" aria-hidden="true" />
                      Calculando preço...
                    </p>
                  )}
                </div>

                {hasKitStep ? (
                  <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-xs text-slate-300">
                    <p className="font-medium text-slate-200">Itens do kit</p>
                    <ul className="mt-1 list-disc space-y-0.5 pl-4">
                      {activeKitItems.map((item) => (
                        <li key={item.id}>
                          {item.name} x{item.quantity_per_participant}
                          {item.is_required ? ' (obrigatório)' : ' (opcional)'}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <div>
                      {shouldShowItemConfiguration ? (
                        <>
                          <p className="text-xs font-medium text-slate-300">Configuração individual dos ingressos</p>
                          <p className="mt-1 text-[11px] text-slate-500">
                            {enforcePhysicalStock
                              ? 'Estoque físico em vigor. Variantes com 5 ou menos unidades exibem alerta de baixa disponibilidade.'
                              : `Livre para encomenda${event.shirt_order_deadline ? ` até ${deadlineText(event.shirt_order_deadline)}` : ''}.`}
                          </p>
                          <div className="mt-2 space-y-2">
                            {activeCheckoutItems.map((item, index) => {
                        const anotherItemIsSelf = activeCheckoutItems.some((other, otherIndex) => otherIndex !== index && other.ownershipMode === 'self');
                        const selfOwnershipBlocked = buyerAlreadyHoldsActiveTicket !== false;
                        const selfOptionDisabled = item.ownershipMode !== 'self' && (selfOwnershipBlocked || anotherItemIsSelf);
                        return (
                        <div key={item.clientId} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                          <p className="text-xs uppercase tracking-[0.18em] text-slate-400">Ingresso {index + 1}</p>
                          <div className={`mt-2 rounded-lg border px-3 py-2 text-xs ${item.visualStatus === 'pricing_error' ? 'border-rose-500/30 bg-rose-500/10 text-rose-100' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-100'}`}>
                            {item.visualStatus === 'complete'
                              ? 'Completo'
                              : item.visualStatus === 'out_of_stock'
                                ? 'Sem estoque'
                                : item.visualStatus === 'price_updated'
                                  ? 'Preco atualizado'
                                  : item.visualStatus === 'pricing_error'
                                    ? (item.pricingError || 'Falha ao calcular preco')
                                    : 'Faltam dados'}
                          </div>
                          <div className="mt-2 grid gap-2 sm:grid-cols-3">
                            <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-2 py-2">
                              <input
                                type="radio"
                                name={`ownership-${index}`}
                                checked={item.ownershipMode === 'unassigned'}
                                onChange={() => updateCheckoutItem(index, { ownershipMode: 'unassigned' })}
                              />
                              <span>Definir depois</span>
                            </label>
                            <label className={`flex items-center gap-2 rounded-lg border border-slate-700 px-2 py-2 ${selfOptionDisabled ? 'opacity-50' : ''}`}>
                              <input
                                type="radio"
                                name={`ownership-${index}`}
                                checked={item.ownershipMode === 'self'}
                                disabled={selfOptionDisabled}
                                onChange={() => updateCheckoutItem(index, { ownershipMode: 'self' })}
                              />
                              <span>
                                {buyerAlreadyHoldsActiveTicket === true
                                  ? 'Você já possui um ingresso neste evento.'
                                  : anotherItemIsSelf
                                    ? 'Já atribuído a outro ingresso'
                                    : 'Este ingresso e para mim'}
                              </span>
                            </label>
                            <label className="flex items-center gap-2 rounded-lg border border-slate-700 px-2 py-2">
                              <input
                                type="radio"
                                name={`ownership-${index}`}
                                checked={item.ownershipMode === 'named'}
                                onChange={() => updateCheckoutItem(index, { ownershipMode: 'named' })}
                              />
                              <span>Informar titular agora</span>
                            </label>
                          </div>

                          <div className="mt-3 grid gap-2 sm:grid-cols-2">
                            <label className="space-y-1">
                              <span className="text-xs text-slate-300">Genero</span>
                              <select
                                value={item.pricingGender ?? ''}
                                onChange={async (event_) => {
                                  const pricingGender = normalizePricingGenderInput(event_.target.value);
                                  const nextItems = checkoutItems.map((entry, entryIndex) => (
                                    entryIndex === index ? { ...entry, pricingGender } : entry
                                  ));
                                  setCheckoutItems(nextItems);
                                  await refreshItemPricingByCoupon(form.coupon_code || undefined, nextItems);
                                }}
                                className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              >
                                <option value="">Selecione</option>
                                <option value="male">Masculino</option>
                                <option value="female">Feminino</option>
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs text-slate-300">Camiseta</span>
                              <select
                                value={item.shirtType}
                                onChange={(event_) => updateCheckoutItem(index, { shirtType: event_.target.value, shirtSize: '' })}
                                className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              >
                                <option value="">Selecione</option>
                                {availableShirtTypes.map((shirtTypeOption) => (
                                  <option key={`${item.clientId}-${shirtTypeOption}`} value={shirtTypeOption}>
                                    {shirtTypeOption}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <label className="space-y-1">
                              <span className="text-xs text-slate-300">Tamanho</span>
                              <select
                                value={item.shirtSize}
                                onChange={(event_) => updateCheckoutItem(index, { shirtSize: event_.target.value })}
                                disabled={!item.shirtType}
                                className="h-10 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm disabled:opacity-50"
                              >
                                <option value="">Selecione</option>
                                {getSizeOptionsForType(item.shirtType, index).map((size) => {
                                  const effectiveStock = getEffectiveStockForItemVariant(index, item.shirtType, size);
                                  const disabledOption = enforcePhysicalStock && effectiveStock <= 0;
                                  return (
                                    <option
                                      key={`${item.clientId}-${item.shirtType}-${size}`}
                                      value={size}
                                      disabled={disabledOption}
                                    >
                                      {size} - {shirtAvailabilityText(effectiveStock, enforcePhysicalStock)}
                                    </option>
                                  );
                                })}
                              </select>
                            </label>

                            <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-200 sm:col-span-2">
                              {item.shirtType && item.shirtSize
                                ? shirtAvailabilityText(getEffectiveStockForItemVariant(index, item.shirtType, item.shirtSize), enforcePhysicalStock)
                                : (!enforcePhysicalStock ? 'Disponivel para encomenda' : 'Selecione modelo e tamanho para ver disponibilidade')}
                            </div>

                            <div className="rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs">
                              <p>{item.pricingGender === 'female' ? 'Feminino' : item.pricingGender === 'male' ? 'Masculino' : 'Nao definido'}</p>
                              {item.visualStatus === 'pricing_error' ? (
                                <p className="text-rose-300">Preço indisponível — corrija para continuar.</p>
                              ) : !item.pricingGender && !isRepricingItems ? (
                                <p className="text-slate-400">Selecione o gênero para calcular o preço.</p>
                              ) : isRepricingItems || (item.visualStatus !== 'price_updated' && item.visualStatus !== 'complete') ? (
                                <p className="text-slate-400">Calculando preço...</p>
                              ) : (
                                <>
                                  <p className="font-medium text-emerald-300">{money(item.finalAmount)}</p>
                                  <p className="text-slate-400">Base {money(item.unitPrice)} | Desc {money(item.discountAmount)}</p>
                                </>
                              )}
                            </div>
                          </div>

                          {item.ownershipMode === 'named' ? (
                            <div className="mt-2 grid gap-2 sm:grid-cols-2">
                              <input
                                value={item.holder_full_name}
                                onChange={(event_) => updateCheckoutItem(index, { holder_full_name: event_.target.value })}
                                placeholder="Nome do titular"
                                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              />
                              <input
                                value={item.holder_cpf}
                                onChange={(event_) => updateCheckoutItem(index, { holder_cpf: event_.target.value })}
                                placeholder="CPF do titular"
                                inputMode="numeric"
                                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              />
                              <input
                                value={item.holder_email}
                                onChange={(event_) => updateCheckoutItem(index, { holder_email: event_.target.value })}
                                placeholder="E-mail (opcional)"
                                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              />
                              <input
                                value={item.holder_phone}
                                onChange={(event_) => updateCheckoutItem(index, { holder_phone: event_.target.value })}
                                placeholder="Telefone (opcional)"
                                inputMode="tel"
                                className="h-10 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm"
                              />
                              <p className="sm:col-span-2 text-[11px] leading-4 text-slate-400">Para vincular automaticamente, informe um CPF válido ou e-mail e telefone. Somente o nome será mantido como informação da compra, sem criar titularidade.</p>
                            </div>
                          ) : null}

                          {item.validationErrors.length > 0 ? (
                            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-rose-200">
                              {item.validationErrors.map((err) => (
                                <li key={`${item.clientId}-${err}`}>{err}</li>
                              ))}
                            </ul>
                          ) : null}

                          {index < activeCheckoutItems.length - 1 ? (
                            <button
                              type="button"
                              onClick={async () => {
                                const nextItems = checkoutItems.map((entry, entryIndex) => (
                                  entryIndex <= index ? entry : {
                                    ...entry,
                                    pricingGender: item.pricingGender,
                                    shirtType: item.shirtType,
                                    shirtSize: item.shirtSize,
                                  }
                                ));
                                setCheckoutItems(nextItems);
                                await refreshItemPricingByCoupon(form.coupon_code || undefined, nextItems);
                              }}
                              className="mt-3 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-200"
                            >
                              Aplicar esta configuracao aos ingressos restantes
                            </button>
                          ) : null}
                        </div>
                        );
                          })}
                        </div>
                      </>
                    ) : (
                      <p className="text-xs text-slate-500">Sem configuração adicional para este evento.</p>
                    )}
                </div>

                <button
                  type="button"
                  onClick={handleChooseTicketNext}
                  disabled={isPending || pricingPhase === 'loading' || pricingPhase === 'error'}
                  className="h-12 w-full rounded-2xl bg-emerald-500 text-base font-semibold text-emerald-950 shadow-lg shadow-emerald-500/20 disabled:opacity-50"
                >
                  {isPending || pricingPhase === 'loading' ? 'Calculando preço...' : pricingPhase === 'error' ? 'Corrija o preço para continuar' : 'Continuar'}
                </button>
              </div>
            )}

            {step === 3 && !registration && !cartOrder && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">3. Revisão</h2>
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
                    <strong>Ingressos:</strong> {form.quantity}
                  </p>
                  <p>
                    <strong>Telefone:</strong> {form.phone}
                  </p>
                  <p>
                    <strong>Cidade:</strong> {form.city}
                  </p>
                  {shouldShowCategoryLabel ? (
                    <p>
                      <strong>Tipo:</strong> {ticketTypeLabel}
                    </p>
                  ) : null}
                  <p>
                    <strong>Quantidade:</strong> {form.quantity}
                  </p>
                  <p>
                    <strong>{isSingleTicketEvent ? 'Ingresso' : 'Lote'}:</strong> {batchDisplayLabel}
                  </p>
                  <p>
                    <strong>Preco:</strong> {summaryValues.original}
                  </p>
                  <p>
                    <strong>Desconto:</strong> {summaryValues.discount}
                  </p>
                  {itemTotals.total > 0 && availablePaymentMethods.length >= 2 ? (
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-sm text-slate-200">Forma de pagamento</span>
                      <select
                        value={form.payment_method}
                        onChange={(event_) => setField('payment_method', event_.target.value as FormState['payment_method'])}
                        className="h-11 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-sm"
                      >
                        {availablePaymentMethods.map((method) => (
                          <option key={method} value={method}>{paymentMethodLabel(method)}</option>
                        ))}
                      </select>
                    </label>
                  ) : itemTotals.total > 0 ? (
                    <p className="sm:col-span-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2 text-slate-200">
                      Forma de pagamento: <strong>{paymentMethodLabel(form.payment_method)}</strong>
                    </p>
                  ) : (
                    <p className="sm:col-span-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-100">
                      {zeroPaymentSummaryReason?.message ?? 'Nenhum pagamento sera necessario.'}
                    </p>
                  )}
                  <p>
                    <strong>Pagamento:</strong> {itemTotals.total <= 0 ? 'Nao necessario' : paymentMethodLabel(form.payment_method)}
                  </p>
                  <p>
                    <strong>Total:</strong> {summaryValues.total}
                  </p>
                  <div className="sm:col-span-2 space-y-2 rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                    <p className="font-medium text-slate-100">Resumo item a item</p>
                    {activeCheckoutItems.map((item, index) => (
                      <p key={`resume-item-${item.clientId}`}>
                        #{index + 1} - {item.shirtType || '-'} / {item.shirtSize || '-'} - {money(item.finalAmount)}
                      </p>
                    ))}
                  </div>
                </div>

                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={handleCreateAndContinuePayment}
                    disabled={submitting}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950 disabled:opacity-50"
                  >
                    {submitting ? 'Criando pedido...' : 'Continuar para o carrinho'}
                  </button>
                </div>
              </div>
            )}

            {step === 3 && !registration && cartOrder && (
              <CartStep
                orderId={cartOrder.orderId}
                eventId={event.id}
                paymentMethod={form.payment_method}
                onContinue={(order) => void handleCartFinalized(order as OrderSnapshotPayload)}
              />
            )}

            {step === 3 && registration && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">3. Pagamento do pedido</h2>

                <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                  <p>
                    Comprador: <strong>{registration.participant_name}</strong>
                  </p>
                  <p>
                    Itens no pedido: <strong>{orderItemsLabel(registration.items)}</strong>
                  </p>
                  <p>
                    Valor: <strong className="text-emerald-300">{money(registration.payment.final_amount)}</strong>
                  </p>
                  <p>
                    Pagamento: <strong>{getStatusLabel(registration.payment.payment_status)}</strong>
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

                {(registration.payment.payment_method ?? form.payment_method) === 'pix' && (
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

                {registration.items && registration.items.length > 0 ? (
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                    <p className="font-medium text-slate-100">Itens do pedido</p>
                    <ul className="mt-2 space-y-2">
                      {registration.items.map((item) => {
                        // Subtotal e sempre BRUTO (quantidade x preco unitario, antes de
                        // qualquer desconto) -- final_amount ja vem com o desconto
                        // subtraido, entao mostrar so ele como "Subtotal" mentiria pro
                        // comprador (a conta na cabeca -- subtotal - desconto - nao
                        // bateria com o total final exibido).
                        const lineSubtotal = item.unit_price * item.quantity;
                        return item.item_kind === 'ticket' ? (
                          <li key={item.order_item_id} className="rounded-lg border border-slate-700 px-3 py-2">
                            <p>Ingresso {item.item_position} - {item.category_name || ticketTypeLabel}</p>
                            <p>Titular: {item.titular_display}</p>
                            <p>{getStatusLabel(item.status)}</p>
                            <p className="font-semibold text-slate-100">{money(lineSubtotal)}</p>
                            {item.discount_amount > 0 ? (
                              <>
                                <p className="text-emerald-300">Desconto: -{money(item.discount_amount)}</p>
                                <p className="text-slate-300">Total da linha: {money(item.final_amount)}</p>
                              </>
                            ) : null}
                          </li>
                        ) : (
                          <li key={item.order_item_id} className="rounded-lg border border-slate-700 px-3 py-2">
                            <p>{item.store_item_name}{item.variant_name ? ` · ${item.variant_name} ${item.variant_value}` : ''}</p>
                            <p>{item.quantity}x {money(item.unit_price)}</p>
                            <p className="font-semibold text-slate-100">Subtotal: {money(lineSubtotal)}</p>
                            {item.discount_amount > 0 ? (
                              <>
                                <p className="text-emerald-300">Desconto: -{money(item.discount_amount)}</p>
                                <p className="text-slate-300">Total da linha: {money(item.final_amount)}</p>
                              </>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}

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
                      onClick={() => unlockAndGoTo(4)}
                      className="h-11 rounded-2xl border border-slate-700 px-6 text-sm text-slate-200"
                    >
                      Ver resumo do pedido
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      const ticketId = registration.items?.find((item) => item.ticket_id)?.ticket_id;
                      if (ticketId) {
                        router.push(`/minha-conta/ingressos/${ticketId}`);
                        return;
                      }
                      unlockAndGoTo(4);
                    }}
                    className="h-11 rounded-2xl bg-emerald-500 px-6 text-sm font-semibold text-emerald-950"
                  >
                    Ver ingresso
                  </button>
                )}
              </div>
            )}

            {step === 4 && registration && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold">4. Resumo final do pedido</h2>
                <div className="rounded-2xl border border-emerald-700/40 bg-emerald-950/20 p-4 text-sm text-emerald-100">
                  <p>
                    Pedido registrado para <strong>{registration.participant_name}</strong>.
                  </p>
                  <p>
                    Inscrição: <strong>{getStatusLabel(registration.reservation_status)}</strong>
                  </p>
                  <p>
                    Pagamento: <strong>{getStatusLabel(registration.payment.payment_status)}</strong>
                  </p>
                  <p>
                    Total pago: <strong>{money(registration.payment.final_amount)}</strong>
                  </p>
                  {courtesyMessage ? <p>{courtesyMessage}</p> : null}
                  <p>
                    Protocolo: <strong>{registration.order_id || registration.participant_id}</strong>
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
                    {shouldShowCategoryLabel ? <p><strong>Tipo:</strong> {registration.category_name || 'Ingresso único'}</p> : null}
                    <p><strong>Itens:</strong> {orderItemsLabel(registration.items)}</p>
                    <p><strong>{isSingleTicketEvent ? 'Ingresso' : 'Lote'}:</strong> {isSingleTicketEvent ? 'Ingresso único' : (registration.batch_name || '-')}</p>
                    <p><strong>Camiseta:</strong> {registration.shirt_type || '-'} / {registration.shirt_size || '-'}</p>
                    <p><strong>Valor original:</strong> {money(registration.payment.amount)}</p>
                    <p><strong>Desconto:</strong> {money(registration.payment.discount_amount)}</p>
                    <p><strong>Valor final:</strong> {money(registration.payment.final_amount)}</p>
                    <p><strong>Pagamento:</strong> {getStatusLabel(registration.payment.payment_status)}</p>
                  </div>

                  {registration.payment.payment_status === 'paid' && registration.qr_token ? (
                    <div className="mt-4 space-y-3">
                      <p className="text-emerald-200">Pagamento confirmado. O ingresso com titular definido ja possui QR Code e PDF.</p>
                      <TicketViewer
                        eventName={event.name}
                        participantName={registration.participant_name}
                        status="active"
                        categoryName={registration.category_name}
                        eventDate={event.starts_at ? String(event.starts_at) : null}
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

                  {ticketLines(registration.items).length > 0 ? (
                    <div className="mt-4">
                      <p className="text-sm font-medium text-slate-100">Ingressos do pedido</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {ticketLines(registration.items).map((item) => (
                          <li key={item.order_item_id}>
                            Ingresso {item.item_position}: {item.titular_display} - {getStatusLabel(item.ticket_status || item.status)} - {money(item.unit_price)}
                            {item.discount_amount > 0 ? ` (desconto -${money(item.discount_amount)}, total ${money(item.final_amount)})` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {productLines(registration.items).length > 0 ? (
                    <div className="mt-4">
                      <p className="text-sm font-medium text-slate-100">Produtos do pedido</p>
                      <ul className="mt-2 list-disc space-y-1 pl-5">
                        {productLines(registration.items).map((item) => (
                          <li key={item.order_item_id}>
                            {item.store_item_name}{item.variant_name ? ` · ${item.variant_name} ${item.variant_value}` : ''} - {item.quantity}x {money(item.unit_price)} - Subtotal: {money(item.unit_price * item.quantity)}
                            {item.discount_amount > 0 ? ` (desconto -${money(item.discount_amount)}, total ${money(item.final_amount)})` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}

                  {registration.kit_items.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-5">
                      {registration.kit_items.map((item) => (
                        <li key={item.kit_item_id}>
                          {item.item_name} x{item.quantity} - {getStatusLabel(item.status)}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2">Sem itens de kit vinculados.</p>
                  )}
                </div>

                {storeItems.length > 0 ? (
                  <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-sm text-slate-200">
                    <p className="font-medium text-slate-100">Que tal levar também...</p>
                    <p className="mt-1 text-xs text-slate-400">Itens opcionais do evento, comprados separadamente do ingresso.</p>
                    <div className="mt-3">
                      <StoreCart eventId={event.id} items={storeItems} />
                    </div>
                  </div>
                ) : null}

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
                  {shouldShowCategoryLabel ? <p>Categoria: {summaryValues.category}</p> : null}
                  <p>Quantidade: {summaryValues.quantity}</p>
                  <p>{isSingleTicketEvent ? 'Ingresso' : 'Lote'}: {summaryValues.batch}</p>
                  {summaryValues.groupedShirts.map(([shirtKey, qty]) => (
                    <p key={`d-s-${shirtKey}`} className="text-xs text-slate-400">{qty}x {shirtKey.replace('::', ' / ')}</p>
                  ))}
                  {summaryValues.productLines.map((line) => (
                    <p key={`d-p-${line.key}`} className="text-xs text-slate-400">{line.label}</p>
                  ))}
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
