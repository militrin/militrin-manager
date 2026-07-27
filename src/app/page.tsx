import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { ParticipantAuthCard } from '@/components/public/ParticipantAuthCard';

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect('/minha-conta');
  }

  return <ParticipantAuthCard title="Entre na sua conta" subtitle="Acesse seus ingressos, QR Codes e histórico no Militrin." defaultNext="/minha-conta" />;
}