import { cookies } from 'next/headers';
import { hasSupabaseAuthCookie } from '@/lib/auth/middleware-guard';
import { HomeButtonLink } from '@/components/HomeButtonLink';

export async function HomeButton() {
  const cookieStore = await cookies();
  const hasSessionCookie = hasSupabaseAuthCookie(cookieStore.getAll().map((cookie) => cookie.name));
  const href = hasSessionCookie ? '/minha-conta' : '/';

  return <HomeButtonLink href={href} hasSessionCookie={hasSessionCookie} />;
}
