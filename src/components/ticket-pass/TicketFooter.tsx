import { TICKET_PASS_COPY } from './ticket-pass-format';

export function TicketFooter() {
  return (
    <footer className="px-5 pb-6 pt-5 text-center sm:px-6">
      <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-zinc-500">
        {TICKET_PASS_COPY.footerLine1}
      </p>
      <p className="mt-2 text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-600">{TICKET_PASS_COPY.footerLine2}</p>
    </footer>
  );
}
