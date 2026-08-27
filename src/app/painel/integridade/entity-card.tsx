'use client';

import Link from 'next/link';

export type IntegrityEntity = {
  entity_type: string;
  entity_id: string;
  event_id: string | null;
  title: string;
  description: string;
  action_label: string | null;
  action_href: string | null;
  metadata: unknown;
};

function str(metadata: unknown, key: string): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(metadata: unknown, key: string): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'number' ? value : null;
}

function contextLine(parts: (string | null)[]): string | null {
  const filtered = parts.filter((part): part is string => Boolean(part));
  return filtered.length > 0 ? filtered.join(' · ') : null;
}

const TICKET_STATUS_LABELS: Record<string, string> = { active: 'Ativo', used: 'Usado', cancelled: 'Cancelado' };
const KIT_ITEM_STATUS_LABELS: Record<string, string> = { reserved: 'Reservado', confirmed: 'Confirmado', delivered: 'Entregue', cancelled: 'Cancelado' };

type Card = { heading: string; context: string | null; badge: string | null };

// Um renderer por code -- le so `metadata` (nunca personaliza title/description,
// que continuam genericos porque a RPC agregadora faz array_agg(title)[1] e
// e usada tambem pelo card resumo/Dashboard). Cobre os 14 detectores da V1;
// qualquer code novo cai no fallback (heading = titulo generico do detector).
// Exportada: reusada por integrity-center.tsx pro card resumido (1 afetado)
// mostrar o mesmo "quem/qual" que o drawer, sem duplicar a logica por code.
export function buildCard(code: string, entity: IntegrityEntity): Card {
  const metadata = entity.metadata;
  switch (code) {
    case 'TICKET_NAMED_WITHOUT_CANONICAL_HOLDER':
      return {
        heading: str(metadata, 'holder_name') ?? 'Titular sem nome informado',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'ticket_code')]),
        badge: null,
      };
    case 'DUPLICATE_ACTIVE_HOLDER': {
      const status = str(metadata, 'ticket_status');
      return {
        heading: str(metadata, 'holder_name') ?? 'Titular sem nome',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'category_name'), str(metadata, 'batch_name'), str(metadata, 'ticket_code')]),
        badge: status ? (TICKET_STATUS_LABELS[status] ?? status) : null,
      };
    }
    case 'LEGACY_HOLDER_REFERENCE_MISMATCH': {
      const legacy = str(metadata, 'legacy_holder_name');
      return {
        heading: str(metadata, 'current_holder_name') ?? 'Titular atual',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'ticket_code'), legacy ? `Cadastro legado: ${legacy}` : null]),
        badge: null,
      };
    }
    case 'PAID_ORDER_WITHOUT_TICKET': {
      // Heading = O QUE ACONTECEU (igual pra toda ocorrencia deste code).
      // Context = QUEM/QUAL: Pedido · Titular · Evento · Categoria -- o
      // "quem" que faltava no card resumido (auditoria do caso real
      // #001078: sem isso o operador nao sabia qual pedido/pessoa olhar sem
      // abrir o drawer ou a pagina do pedido).
      const orderNumber = str(metadata, 'order_number');
      return {
        heading: 'Ingresso não emitido',
        context: contextLine([orderNumber ? `Pedido ${orderNumber}` : null, str(metadata, 'holder_name'), str(metadata, 'event_name'), str(metadata, 'category_name')]),
        badge: null,
      };
    }
    case 'TICKET_WITHOUT_ORDER_ITEM': {
      const status = str(metadata, 'ticket_status');
      return {
        heading: str(metadata, 'ticket_code') ?? 'Ingresso',
        context: contextLine([str(metadata, 'event_name')]),
        badge: status ? (TICKET_STATUS_LABELS[status] ?? status) : null,
      };
    }
    case 'SINGLE_TICKET_PRICE_NOT_CONFIRMED':
    case 'NO_PURCHASABLE_CATEGORY_OPTION':
    case 'EVENT_SHIRT_KIT_WITHOUT_VARIANTS':
      return { heading: str(metadata, 'event_name') ?? 'Evento', context: null, badge: null };
    case 'ORDER_ITEM_CATEGORY_EVENT_MISMATCH': {
      const orderNumber = str(metadata, 'order_number');
      return {
        heading: orderNumber ? `Pedido ${orderNumber}` : 'Pedido',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'wrong_category_name'), str(metadata, 'wrong_batch_name')]),
        badge: null,
      };
    }
    case 'TICKET_MISSING_REQUIRED_SHIRT_VARIANT':
      return {
        heading: str(metadata, 'holder_name') ?? 'Titular sem nome',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'category_name'), str(metadata, 'ticket_code')]),
        badge: str(metadata, 'kit_item_name'),
      };
    case 'TICKET_CANCELLED_WITH_PENDING_KIT_ITEM': {
      const status = str(metadata, 'kit_item_status');
      return {
        heading: str(metadata, 'holder_name') ?? 'Titular sem nome',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'kit_item_name')]),
        badge: status ? (KIT_ITEM_STATUS_LABELS[status] ?? status) : null,
      };
    }
    case 'SHIRT_INVENTORY_DELIVERED_EXCEEDS_TOTAL': {
      const delivered = num(metadata, 'delivered_quantity');
      const total = num(metadata, 'total_quantity');
      return {
        heading: contextLine([str(metadata, 'shirt_type'), str(metadata, 'shirt_size')]) ?? 'Item de estoque',
        context: contextLine([str(metadata, 'event_name'), delivered !== null && total !== null ? `${delivered}/${total} entregues` : null]),
        badge: null,
      };
    }
    case 'TICKET_CANCELLED_WITH_CHECKIN':
      return {
        heading: str(metadata, 'holder_name') ?? str(metadata, 'ticket_code') ?? 'Ingresso',
        context: contextLine([str(metadata, 'event_name'), str(metadata, 'ticket_code')]),
        badge: null,
      };
    case 'OPEN_BLOCKING_DATA_ISSUE':
      return {
        heading: str(metadata, 'contact_name') ?? 'Cadastro',
        context: contextLine([str(metadata, 'event_name')]),
        badge: null,
      };
    default:
      return { heading: entity.title, context: null, badge: null };
  }
}

export function EntityCard({ code, entity }: { code: string; entity: IntegrityEntity }) {
  const card = buildCard(code, entity);
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
      <p className="text-sm font-semibold text-slate-100">{card.heading}</p>
      {card.context && <p className="mt-0.5 text-xs text-slate-400">{card.context}</p>}
      {card.badge && (
        <span className="mt-1.5 inline-block rounded-full border border-slate-600 px-2 py-0.5 text-[10px] font-medium text-slate-300">{card.badge}</span>
      )}
      <p className="mt-1.5 text-xs text-slate-400">{entity.description}</p>
      {entity.action_href && entity.action_label && (
        <Link
          href={entity.action_href}
          className="mt-2 inline-flex min-h-9 items-center text-xs font-semibold text-emerald-300 hover:underline"
        >
          {entity.action_label} →
        </Link>
      )}
    </div>
  );
}
