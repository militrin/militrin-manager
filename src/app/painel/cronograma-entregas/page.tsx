import Link from 'next/link';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { SectionCard } from '@/components/dashboard/SectionCard';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export default async function AdminScheduleIndexPage() {
  const supabase = await createServerSupabaseClient();
  const { data: events, error } = await supabase.from('events').select('id,name,starts_at,is_active').order('starts_at', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,var(--brand-glow-strong),transparent_30%),linear-gradient(135deg,#030712,#0f172a)] px-4 py-6 text-slate-100 sm:px-6 lg:px-8"><div className="mx-auto flex max-w-7xl flex-col gap-6 lg:flex-row"><Sidebar /><div className="flex-1 space-y-6"><TopBar title="Cronogramas dos eventos" subtitle="Escolha um evento para administrar seus compromissos" /><SectionCard title="Eventos" description="Cada compromisso fica isolado no cronograma do respectivo evento."><div className="space-y-2">{(events ?? []).map((event) => <Link key={event.id} href={`/painel/eventos/${event.id}?etapa=7`} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-sm hover:border-emerald-500/40"><span>{event.name}</span><span className="text-xs text-slate-400">{event.is_active ? 'Ativo' : 'Inativo'} · Abrir cronograma</span></Link>)}</div></SectionCard></div></div></main>;
}
