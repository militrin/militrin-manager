import type { TicketIdentityView } from "@/lib/registrations/contact-tickets";

export function TicketIdentitySummary({
  identity,
  className = "mt-2 space-y-1 text-sm text-slate-300",
}: {
  identity: TicketIdentityView;
  className?: string;
}) {
  const accountClassName = identity.holderAccountKind === "pending_first_access" || identity.holderAccountKind === "unlinked"
    ? "text-amber-200"
    : undefined;
  return (
    <div className={className}>
      <p>Titular: {identity.holderName}</p>
      <p className={accountClassName}>Conta do titular: {identity.holderAccountLabel}</p>
      <p>Proprietário: {identity.ownerName}</p>
      {identity.intendedOwnerName ? <p className="text-xs text-slate-400">Pretendido: {identity.intendedOwnerName}</p> : null}
    </div>
  );
}
