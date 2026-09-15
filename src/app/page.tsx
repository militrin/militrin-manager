import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getPublicEvents } from '@/lib/public/events';
import { PublicLanding, type PublicLandingEvent } from '@/components/public/PublicLanding';

export const metadata: Metadata = {
  title: 'Militrin 2026',
  description: 'Seu acesso ao Militrin em um só lugar. Consulte seu pacote, QR Code, compras e informações do evento.',
};

function pickFeaturedEvent(events: Array<{
  name: string;
  year: number | null;
  slug: string;
  location: string | null;
  startsAt: string | null;
  endsAt: string | null;
  description: string | null;
  bannerHeroUrl: string | null;
  bannerCardUrl: string | null;
}>): PublicLandingEvent {
  const featured =
    events.find((event) => /^militrin$/i.test(event.name.trim())) ??
    events.find((event) => /militrin/i.test(event.name) && !/esquenta|old/i.test(event.name)) ??
    events[0] ??
    null;
  if (!featured) return null;
  return {
    name: featured.name,
    year: featured.year,
    slug: featured.slug,
    location: featured.location,
    startsAt: featured.startsAt,
    endsAt: featured.endsAt,
    description: featured.description,
    bannerHeroUrl: featured.bannerHeroUrl,
    bannerCardUrl: featured.bannerCardUrl,
  };
}

export default async function Home() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    redirect('/minha-conta');
  }

  const { events } = await getPublicEvents();

  return <PublicLanding event={pickFeaturedEvent(events)} />;
}
