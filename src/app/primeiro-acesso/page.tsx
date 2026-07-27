import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getFirstAccessFlags } from '@/lib/account/first-access';
import { FirstAccessForm } from './FirstAccessForm';

export default async function PrimeiroAcessoPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user?.id) {
    redirect('/entrar?next=/primeiro-acesso');
  }

  const flags = await getFirstAccessFlags(user.id);
  if (!flags.mustChangePassword && !flags.mustCompleteProfile) {
    redirect('/minha-conta');
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <section className="mx-auto w-full max-w-2xl rounded-3xl border border-slate-800/80 bg-slate-900/70 p-6">
        <h1 className="text-3xl font-semibold text-white">Primeiro acesso</h1>
        <p className="mt-2 text-sm text-slate-300">Defina sua nova senha e complete seu perfil para liberar sua conta.</p>

        <FirstAccessForm />
      </section>
    </main>
  );
}
