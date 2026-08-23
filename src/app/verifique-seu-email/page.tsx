import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import { VerifyEmailClient } from './verify-email-client';

export default async function VerifiqueSeuEmailPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email: emailParam } = await searchParams;
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Duas origens possiveis: (1) acabou de criar conta / tentou logar sem
  // confirmar -- sem sessao, so temos o e-mail que a pessoa digitou; (2) uma
  // sessao existe mas o e-mail nao esta confirmado (rede de seguranca do
  // layout de /minha-conta). Nos dois casos a tela e a mesma.
  if (user) {
    if (isEmailConfirmed(user)) {
      redirect('/minha-conta');
    }
    return <VerifyEmailClient email={user.email ?? emailParam ?? ''} />;
  }

  const email = emailParam?.trim();
  if (!email) redirect('/entrar');

  return <VerifyEmailClient email={email} />;
}
