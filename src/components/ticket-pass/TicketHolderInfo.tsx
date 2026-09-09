import { CheckCircle2, Hash, Ticket as TicketIcon, User } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatEventPassOrderNumber, TICKET_PASS_COPY, ticketPassStatusPresentation } from './ticket-pass-format';

type TicketHolderInfoProps = {
  holderName?: string | null;
  categoryName?: string | null;
  orderNumber?: string | null;
  status: string;
};

function InfoRow({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/6 bg-white/[0.035] px-3 py-2.5">
      <span className="mt-0.5 text-(--brand-400)">{icon}</span>
      <div className="min-w-0">
        <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-zinc-500">{label}</p>
        <p className={valueClassName ?? 'truncate text-sm font-semibold text-zinc-50'}>{value}</p>
      </div>
    </div>
  );
}

function StatusValue({ status }: { status: string }) {
  const presentation = ticketPassStatusPresentation(status);
  if (presentation.isActive) {
    return (
      <span className="inline-flex items-center gap-1.5 text-sm font-semibold tracking-[0.14em] text-emerald-400">
        <CheckCircle2 size={15} strokeWidth={2.25} aria-hidden />
        {presentation.text}
      </span>
    );
  }

  const normalized = status.trim().toLowerCase();
  const tone =
    normalized === 'used'
      ? 'text-sky-300'
      : ['cancelled', 'canceled'].includes(normalized)
        ? 'text-rose-300'
        : 'text-zinc-100';

  return <span className={`text-sm font-semibold uppercase tracking-[0.14em] ${tone}`}>{presentation.text}</span>;
}

export function TicketHolderInfo({ holderName, categoryName, orderNumber, status }: TicketHolderInfoProps) {
  const orderLabel = formatEventPassOrderNumber(orderNumber);

  return (
    <section className="grid gap-2 px-5 pt-5 sm:px-6">
      {holderName ? (
        <InfoRow icon={<User size={15} strokeWidth={1.75} aria-hidden />} label={TICKET_PASS_COPY.holderLabel} value={holderName} />
      ) : null}
      {categoryName ? (
        <InfoRow icon={<TicketIcon size={15} strokeWidth={1.75} aria-hidden />} label={TICKET_PASS_COPY.categoryLabel} value={categoryName} />
      ) : null}
      {orderLabel ? (
        <InfoRow icon={<Hash size={15} strokeWidth={1.75} aria-hidden />} label={TICKET_PASS_COPY.orderLabel} value={orderLabel} valueClassName="font-mono text-sm font-semibold tracking-[0.12em] text-zinc-50" />
      ) : null}
      <InfoRow icon={<CheckCircle2 size={15} strokeWidth={1.75} aria-hidden />} label={TICKET_PASS_COPY.statusLabel} value={<StatusValue status={status} />} />
    </section>
  );
}
