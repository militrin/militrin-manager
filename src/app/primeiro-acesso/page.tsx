import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getProfileCompletionStatus } from '@/lib/account/profile-completion';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import Link from 'next/link';
import { FirstAccessForm } from './FirstAccessForm';
import { getParticipantInviteContext, getParticipantInviteFailureCopy } from '@/lib/account/participant-invite';
import { isValidCpf } from '@/lib/validation/registration';
import { resolveAdministrativeLandingPage } from '@/lib/navigation/admin-landing';

export default async function PrimeiroAcessoPage({ searchParams }: { searchParams: Promise<{ next?: string; invite?: string }> }) {
  const params = await searchParams;
  const safeNext = sanitizePostFirstAccessNextPath(params.next, '/minha-conta');

  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    redirect('/entrar?next=/primeiro-acesso');
  }

  const status = await getProfileCompletionStatus(user.id, user.email ?? null);
  const inviteContext = params.invite ? await getParticipantInviteContext(params.invite, user) : null;

  const administrativeLandingPage = !params.invite
    ? await resolveAdministrativeLandingPage()
    : null;
  if (administrativeLandingPage) {
    redirect(administrativeLandingPage);
  }

  if (params.invite && !inviteContext?.valid) {
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

  if (status.isComplete && !params.invite) {
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
    email: preferParticipant('email') || String(user.email ?? ''),
    city: preferParticipant('city'),
  };
  const editableFields = new Set(inviteContext?.userResolvableFields ?? status.missingFields);
  if (!initialValues.full_name) editableFields.add('full_name');
  if (!isValidCpf(initialValues.cpf)) editableFields.add('cpf');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(initialValues.birth_date)) editableFields.add('birth_date');
  if (!initialValues.phone.replace(/\D/g, '') || initialValues.phone.replace(/\D/g, '').length < 10) editableFields.add('phone');
  if (!initialValues.city) editableFields.add('city');

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <h1 className="text-3xl font-semibold text-white">Vamos concluir seu cadastro</h1>
        <p className="mt-2 text-sm text-slate-300">Confirme seus dados para acessar ingressos, compras e QR Codes.</p>

        {editableFields.size > 0 ? (
          <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Complete seu cadastro para continuar.</p>
        ) : null}

        <FirstAccessForm initialValues={initialValues} editableFields={[...editableFields]} mustChangePassword={inviteContext ? inviteContext.requiresPasswordSetup : status.mustChangePassword} nextPath={safeNext} inviteId={params.invite} />
      </section>
    </main>
  );
}
