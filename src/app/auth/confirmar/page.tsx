import { buildInviteErrorCopy, type InviteLinkKind } from "@/lib/auth/invite-error-copy";
import { safeAuthDestination } from "@/lib/auth/callback-destinations";
import { ConfirmFirstAccessForm } from "./ConfirmFirstAccessForm";
import { StripConfirmQuery } from "./StripConfirmQuery";

const allowedTypes = new Set(["invite", "signup", "magiclink", "recovery", "email", "email_change"]);

function linkKindFor(type: string | null): InviteLinkKind {
  if (type === "recovery") return "recovery";
  if (type === "signup" || type === "email" || type === "email_change") return "signup";
  if (type === "magiclink") return "magiclink";
  return "invite";
}

export default async function ConfirmFirstAccessPage({
  searchParams,
}: {
  searchParams: Promise<{ token_hash?: string; type?: string; next?: string }>;
}) {
  const params = await searchParams;
  const tokenHash = String(params.token_hash ?? "");
  const type = String(params.type ?? "");
  const kind = linkKindFor(type);
  const destination = safeAuthDestination(params.next ?? null, kind === "recovery" ? "/redefinir-senha" : "/primeiro-acesso");

  if (!tokenHash || !allowedTypes.has(type)) {
    const copy = buildInviteErrorCopy("invalid", kind);
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
        <section className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-slate-900 p-6 text-center">
          <h1 className="text-xl font-semibold">{copy.title}</h1>
          <p className="mt-2 text-sm text-rose-200">{copy.message}</p>
          <a href={copy.ctaHref} rel="noreferrer" referrerPolicy="no-referrer" className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm">{copy.ctaLabel}</a>
        </section>
      </main>
    );
  }

  const isRecovery = kind === "recovery";

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <StripConfirmQuery />
      <section className="w-full max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-6 text-center">
        <h1 className="text-xl font-semibold">{isRecovery ? "Confirmar redefinição de senha" : "Confirmar primeiro acesso"}</h1>
        <p className="mt-2 text-sm text-slate-300">
          {isRecovery
            ? "Clique para confirmar. Abrir o e-mail não redefine a senha sozinho."
            : "Clique para confirmar. Abrir o e-mail não ativa a conta sozinho."}
        </p>
        <ConfirmFirstAccessForm tokenHash={tokenHash} type={type} next={destination} kind={kind} />
      </section>
    </main>
  );
}
