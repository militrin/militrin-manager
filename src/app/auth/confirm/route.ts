import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { safeAuthDestination } from "@/lib/auth/callback-destinations";
import { categorizeInviteError, logSanitizedAuthLinkFailure, type InviteLinkKind } from "@/lib/auth/invite-error-copy";
import { createPasswordRecoveryState } from "@/lib/account/password-recovery-state";

// Caminho oficial recomendado pelo Supabase para confirmar link de e-mail
// (convite/magic link/recuperacao/confirmacao de cadastro) em apps SSR
// (@supabase/ssr): verifyOtp com token_hash+type, executado inteiramente no
// SERVIDOR, escrevendo a sessao direto nos cookies via createServerSupabaseClient.
// Nunca depende de PKCE code_verifier armazenado no navegador que "iniciou"
// o fluxo -- diferente de exchangeCodeForSession (usado em /auth/callback,
// mantido so como fallback legado/OAuth), verifyOtp valida o token
// diretamente contra o Supabase Auth, entao funciona em qualquer navegador
// ou dispositivo que abra o link, exatamente o requisito de um convite
// administrativo entregue por e-mail.
//
// ATIVACAO: exige que o template de e-mail do Supabase (Convite/Magic Link/
// Recuperacao/Confirmar cadastro, configurados no Dashboard do projeto)
// aponte pra esta rota usando {{ .TokenHash }}/{{ .Type }} em vez do
// {{ .ConfirmationURL }} padrao (que hoje gera um link ?code=... PKCE) --
// ver detalhes no relatorio da tarefa. Ate essa configuracao ser aplicada,
// esta rota fica pronta mas nao e' o caminho realmente exercitado pelos
// links enviados.
const allowedOtpTypes = new Set<EmailOtpType>(["invite", "signup", "magiclink", "recovery", "email", "email_change"]);

function linkKindFor(type: string | null): InviteLinkKind {
  if (type === "recovery") return "recovery";
  if (type === "signup" || type === "email" || type === "email_change") return "signup";
  if (type === "magiclink") return "magiclink";
  return "invite";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tokenHash = searchParams.get("token_hash");
  const typeParam = searchParams.get("type");
  const nextParam = searchParams.get("next");
  const kind = linkKindFor(typeParam);
  const fallbackDestination = kind === "recovery" ? "/redefinir-senha" : "/primeiro-acesso";
  const destination = safeAuthDestination(nextParam, fallbackDestination);

  if (!tokenHash || !typeParam || !allowedOtpTypes.has(typeParam as EmailOtpType)) {
    logSanitizedAuthLinkFailure({ kind, category: "invalid", rawCode: "missing_or_unsupported_type" });
    return NextResponse.redirect(new URL(`/auth/callback?linkError=invalid&kind=${kind}`, request.url));
  }

  const supabase = await createServerSupabaseClient();
  // token_hash nunca e' logado (nem aqui, nem em caso de erro) -- e' uma
  // credencial de uso unico equivalente a uma senha temporaria.
  const { data, error } = await supabase.auth.verifyOtp({ type: typeParam as EmailOtpType, token_hash: tokenHash });

  if (error) {
    const category = categorizeInviteError({ message: error.message, code: (error as { code?: string }).code ?? null });
    logSanitizedAuthLinkFailure({ kind, category, rawCode: (error as { code?: string }).code ?? null });
    return NextResponse.redirect(new URL(`/auth/callback?linkError=${category}&kind=${kind}`, request.url));
  }

  if (kind === "recovery") {
    // /redefinir-senha exige um token de estado (HMAC, curta duracao,
    // amarrado ao e-mail) alem da sessao em si -- sem isso, qualquer sessao
    // valida (ex.: vinda de um Magic Link) poderia trocar a senha da conta.
    // Historicamente esse token so era gerado por requestPasswordResetAction
    // e viajava embutido no `next` do fluxo PKCE antigo (/auth/callback);
    // aqui, no caminho oficial token_hash/verifyOtp, geramos direto no
    // servidor logo apos a verificacao ter sucesso, entao o link de
    // recuperacao funciona mesmo sem depender de `next`.
    const email = data.user?.email ?? "";
    const recoveryState = createPasswordRecoveryState(email);
    return NextResponse.redirect(new URL(`/redefinir-senha?recovery=${encodeURIComponent(recoveryState)}`, request.url));
  }

  return NextResponse.redirect(new URL(destination, request.url));
}
