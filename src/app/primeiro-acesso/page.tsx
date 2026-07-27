import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getProfileCompletionStatus } from '@/lib/account/profile-completion';
import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import Link from 'next/link';
import { FirstAccessForm } from './FirstAccessForm';

export default async function PrimeiroAcessoPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
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

  if (status.error) {
    return (
      <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
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

  if (status.isComplete) {
    redirect(safeNext);
  }

  console.info('[profile-completion:first-access]', {
    userId: user.id,
    profileExists: status.exists,
    missingFields: status.missingFields,
    isComplete: status.isComplete,
  });

  const profileRow = status.profile;

  const initialValues = {
    full_name: String(profileRow?.full_name ?? (user.user_metadata?.full_name as string | undefined) ?? ''),
    cpf: String(profileRow?.cpf ?? (user.user_metadata?.cpf as string | undefined) ?? ''),
    birth_date: String(profileRow?.birth_date ?? (user.user_metadata?.birth_date as string | undefined) ?? ''),
    gender: String(profileRow?.gender ?? (user.user_metadata?.gender as string | undefined) ?? ''),
    phone: String(profileRow?.phone ?? (user.user_metadata?.phone as string | undefined) ?? ''),
    email: String(user.email ?? ''),
    city: String(profileRow?.city ?? (user.user_metadata?.city as string | undefined) ?? ''),
  };

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <h1 className="text-3xl font-semibold text-white">Vamos concluir seu cadastro</h1>
        <p className="mt-2 text-sm text-slate-300">Confirme seus dados para acessar ingressos, compras e QR Codes.</p>

        {status.missingFields.length > 0 ? (
          <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">Complete seu cadastro para continuar.</p>
        ) : null}

        <FirstAccessForm initialValues={initialValues} mustChangePassword={status.mustChangePassword} nextPath={safeNext} />
      </section>
    </main>
  );
}
