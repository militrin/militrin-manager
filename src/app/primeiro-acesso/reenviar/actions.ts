"use server";

import { createServiceRoleSupabaseClient } from "@/lib/supabase/admin";
import { dispatchFirstAccessEmail } from "@/lib/account/first-access-invite-dispatch";

// Fluxo PUBLICO (nao autenticado) de "solicitar novo convite" -- destino do
// CTA que hoje era um mailto: decorativo em /auth/callback e /primeiro-acesso
// quando o link original falha (expirado/ja usado/invalido). Reusa
// integralmente o mesmo mecanismo canonico de reenvio ja usado pelo admin
// (inviteCadastroFirstAccessAction -> dispatchFirstAccessEmail, agora
// compartilhado via src/lib/account/first-access-invite-dispatch.ts) --
// nenhuma RPC nova, nenhum caminho de criacao de conta/participante/cadastro
// paralelo.
//
// Anti-enumeracao: SEMPRE devolve a mesma mensagem generica, exista ou nao
// um convite pendente pra esse e-mail -- mesmo padrao ja usado por
// requestPasswordResetAction (src/app/inscricao/actions.ts). So um erro de
// rate limit de verdade (que por si so nao revela nada sobre a conta) e'
// repassado com mensagem especifica; qualquer outro erro do provedor fica
// so no log do servidor.
//
// Rate limit: nao inventa infraestrutura nova -- se apoia no rate limit
// nativo do GoTrue pra envio de e-mail (o mesmo que ja protege
// resetPasswordForEmail/signInWithOtp em todo o resto do app), detectado
// pela mesma heuristica de mensagem ja usada em requestPasswordResetAction.
//
// Nunca cria conta/participante/cadastro duplicado: so chama
// dispatchFirstAccessEmail com reasonCode 'resend_invite_*' (isResend=true),
// que internamente so faz signInWithOtp({shouldCreateUser:false}) -- nunca
// inviteUserByEmail (que cria conta nova). Se nenhum convite pendente for
// encontrado, nenhuma chamada ao Supabase Auth acontece.
const GENERIC_MESSAGE = "Se houver um convite pendente para este e-mail, um novo link foi enviado. Verifique sua caixa de entrada (e o spam).";

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export async function requestFirstAccessInviteResendAction(rawEmail: string): Promise<{ success: boolean; message: string }> {
  const email = normalizeEmail(String(rawEmail ?? ""));
  if (!email || !email.includes("@")) {
    return { success: false, message: "Informe um e-mail válido." };
  }

  const admin = createServiceRoleSupabaseClient();
  const { data: invite } = await admin
    .from("participant_account_invites")
    .select("id,email")
    .eq("email", email)
    .eq("status", "pending")
    .is("password_setup_completed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Nao encontrado (ou ja concluido/nao mais pendente): resposta identica a
  // do caminho encontrado -- nunca revela se o e-mail tem convite.
  if (!invite?.id) {
    return { success: true, message: GENERIC_MESSAGE };
  }

  const result = await dispatchFirstAccessEmail({
    inviteId: invite.id,
    email: String(invite.email ?? email),
    reasonCode: "resend_invite_self_service",
  });

  if (result.error) {
    console.warn("[first-access:resend-self-service]", { message: result.error.message, code: (result.error as { code?: string }).code ?? null });
    const normalizedMessage = result.error.message.toLowerCase();
    if (normalizedMessage.includes("rate limit") || normalizedMessage.includes("security purposes")) {
      return { success: false, message: "Muitas solicitações em pouco tempo. Aguarde um instante e tente novamente." };
    }
    // Qualquer outro erro do provedor tambem cai na mensagem generica --
    // nunca expõe detalhe tecnico nem confirma/nega a existência do convite.
    return { success: true, message: GENERIC_MESSAGE };
  }

  return { success: true, message: GENERIC_MESSAGE };
}
