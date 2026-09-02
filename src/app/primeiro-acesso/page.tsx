import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getProfileCompletionStatus } from '@/lib/account/profile-completion';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import Link from 'next/link';
import { FirstAccessForm } from './FirstAccessForm';
import { getParticipantInviteContext, getParticipantInviteFailureCopy } from '@/lib/account/participant-invite';
import { validateFirstAccessProfile } from '@/lib/account/first-access-validation';
import { resolveAdministrativeLandingPage } from '@/lib/navigation/admin-landing';

export default async function PrimeiroAcessoPage({ searchParams }: { searchParams: Promise<{ next?: string; invite?: string }> }) {
  const params = await searchParams;
  const safeNext = sanitizePostFirstAccessNextPath(params.next, '/minha-conta');

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    if (params.invite) {
      return (
        <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
          <section className="mx-auto max-w-xl rounded-3xl border border-amber-500/30 bg-slate-900 p-6">
            <h1 className="text-2xl font-semibold">Não foi possível validar o convite</h1>
            <p className="mt-2 text-sm text-slate-300">
              Este link pode ter expirado, já ter sido usado ou ter sido aberto sem as credenciais de ativação.
            </p>
            <a
              href="/primeiro-acesso/reenviar"
              className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm"
            >
              Solicitar novo convite
            </a>
          </section>
        </main>
      );
    }
    redirect('/entrar?next=/primeiro-acesso');
  }

  const status = await getProfileCompletionStatus(user.id, user.email ?? null);
  // Fonte primaria e' o parametro `invite` da URL (compatibilidade com o
  // link hoje enviado, que passa por /auth/callback?next=/primeiro-acesso
  // ?invite=...). Fallback: inviteUserByEmail ja grava participant_invite_id
  // em user_metadata (data: {...}, ver dispatchFirstAccessEmail) -- uma vez
  // autenticado (verifyOtp/exchangeCodeForSession), esse metadado ja
  // identifica o convite sem depender de nenhum parametro de URL ter
  // sobrevivido ao redirecionamento. getParticipantInviteContext revalida
  // elegibilidade/sessao do mesmo jeito nos dois casos -- nunca um atalho de
  // seguranca, so uma fonte alternativa do id.
  const inviteIdFromSession = typeof user.user_metadata?.participant_invite_id === 'string' ? user.user_metadata.participant_invite_id : null;
  const effectiveInviteId = params.invite || inviteIdFromSession || undefined;
  const inviteContext = effectiveInviteId ? await getParticipantInviteContext(effectiveInviteId, user) : null;

  const administrativeLandingPage = !effectiveInviteId
    ? await resolveAdministrativeLandingPage()
    : null;
  if (administrativeLandingPage) {
    redirect(administrativeLandingPage);
  }

  if (effectiveInviteId && !inviteContext?.valid) {
    const failureCopy = getParticipantInviteFailureCopy(inviteContext?.reason);
    return (
      <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
        <section className="mx-auto max-w-xl rounded-3xl border border-amber-500/30 bg-slate-900 p-6">
          <h1 className="text-2xl font-semibold">{failureCopy.title}</h1>
          <p className="mt-2 text-sm text-slate-300">{failureCopy.description}</p>
          <Link href="/" className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm">Voltar</Link>
        </section>
      </main>
    );
  }

  if (status.error) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
        <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
          <h1 className="text-2xl font-semibold text-white">Não foi possível validar seu perfil agora</h1>
          <p className="mt-2 text-sm text-slate-300">Tente novamente em instantes. Se o problema persistir, volte para sua conta.</p>
          <div className="mt-5 flex flex-wrap gap-2">
            <Link href="/primeiro-acesso" className="inline-flex h-10 items-center justify-center rounded-xl border border-slate-700 px-4 text-sm text-slate-100">
              Tentar novamente
            </Link>
            <Link href="/minha-conta" className="inline-flex h-10 items-center justify-center rounded-xl bg-emerald-500 px-4 text-sm font-semibold text-emerald-950">
              Voltar para Minha conta
            </Link>
          </div>
        </section>
      </main>
    );
  }

  if (status.profile?.account_status === 'blocked') {
    redirect('/acesso-negado');
  }

  if (status.isComplete && !effectiveInviteId) {
    redirect(safeNext);
  }

  console.info('[profile-completion:first-access]', {
    userId: user.id,
    profileExists: status.exists,
    missingFields: status.missingFields,
    isComplete: status.isComplete,
  });

  const profileRow = status.profile;
  const invitedParticipant = inviteContext?.participant;
  const preferParticipant = (field: string) => String(invitedParticipant?.[field] ?? '').trim() || String(profileRow?.[field] ?? '').trim();

  const initialValues = {
    full_name: preferParticipant('full_name'),
    cpf: preferParticipant('cpf'),
    birth_date: preferParticipant('birth_date'),
    gender: preferParticipant('gender'),
    phone: preferParticipant('phone'),
    // E-mail e identidade do Auth e nao pode ser substituido por dado do
    // participante/importacao, mesmo que esse dado apareca preenchido.
    email: String(user.email ?? ''),
    city: preferParticipant('city'),
  };
  const editableFields = new Set([...(inviteContext?.userResolvableFields ?? []), ...status.missingFields]);
  const initialValidation = validateFirstAccessProfile(initialValues);
  for (const field of Object.keys(initialValidation.fieldErrors)) editableFields.add(field);

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <h1 className="text-3xl font-semibold text-white">Vamos concluir seu cadastro</h1>
        <p className="mt-2 text-sm text-slate-300">Confirme seus dados para acessar ingressos, compras e QR Codes.</p>

        {editableFields.size > 0 ? (
          <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Complete seu cadastro para continuar.</p>
        ) : null}

        <FirstAccessForm initialValues={initialValues} editableFields={[...editableFields]} mustChangePassword={inviteContext ? inviteContext.requiresPasswordSetup : status.mustChangePassword} nextPath={safeNext} inviteId={effectiveInviteId} />
      </section>
    </main>
  );
}
