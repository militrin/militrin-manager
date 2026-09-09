import { formatEventPassOrderNumber, TICKET_PASS_COPY } from './ticket-pass-format';

type TicketHeaderProps = {
  eventName: string;
  categoryName?: string | null;
  orderNumber?: string | null;
  titleAs?: 'h1' | 'h2';
};

export function TicketHeader({ eventName, categoryName, orderNumber, titleAs = 'h2' }: TicketHeaderProps) {
  const Title = titleAs;
  const orderLabel = formatEventPassOrderNumber(orderNumber);

  return (
    <header className="relative px-5 pt-6 sm:px-6">
      <div className="flex items-start justify-between gap-3">
        <div className="relative h-16 w-16 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-(--brand-500)/50">
          <div aria-hidden className="mask-logo absolute inset-1" />
          <span className="sr-only">Militrin</span>
        </div>
        {orderLabel ? (
          <p className="pt-1 font-mono text-[11px] tracking-[0.18em] text-zinc-500">{orderLabel}</p>
        ) : null}
      </div>

      <p className="mt-5 text-[10px] font-semibold uppercase tracking-[0.32em] text-(--brand-300)">{TICKET_PASS_COPY.eyebrow}</p>
      <Title className="mt-1 text-[1.65rem] font-semibold leading-tight tracking-tight text-zinc-50 sm:text-[1.85rem]">
        {eventName}
      </Title>
      {categoryName ? (
        <p className="mt-1 text-lg font-bold uppercase tracking-[0.18em] text-white">{categoryName}</p>
      ) : null}
    </header>
  );
}
