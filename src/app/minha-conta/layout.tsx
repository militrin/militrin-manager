import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import { getFirstAccessFlags } from '@/lib/account/first-access';
import { isEmailConfirmed } from '@/lib/account/email-confirmation';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
import { signOutAccountAction } from '@/app/minha-conta/actions';
import { PublicPinCopy } from '@/app/minha-conta/public-pin-copy';
import { getMyPublicPin } from '@/lib/account/public-pin';
import { MilitrinAvatar } from '@/components/militrin';
import { resolveAdministrativeLandingPage } from '@/lib/navigation/admin-landing';
import { isAdministrativeIssue, isRequiredUserResolvableIssue } from '@/lib/account/participant-issue-policy';
import { AlertTriangle, LogOut, UsersRound, Trophy, ArrowRight } from 'lucide-react';
import { StoreCartProvider } from '@/lib/store/cart-context';
import { CartHeaderLink } from '@/components/store/CartHeaderLink';
import { AccountSidebarNav, AccountMobileNav } from './account-nav';

const futureNavigation = [
  { href: '/minha-conta/amigos', label: 'Amigos - Em breve', icon: UsersRound },
  { href: '/minha-conta/ranking', label: 'Ranking - Em breve', icon: Trophy },
];

export default async function MinhaContaLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/entrar?next=/minha-conta');
  }

  if (!isEmailConfirmed(user)) {
    redirect(`/verifique-seu-email?email=${encodeURIComponent(user.email ?? '')}`);
  }

  const flags = await getFirstAccessFlags(user.id, user.email ?? null);
  if (flags.isBlocked) {
    redirect('/acesso-negado');
  }

  const administrativeLandingPage = await resolveAdministrativeLandingPage();
  const isAdministrativeUser = Boolean(administrativeLandingPage);
  if (flags.firstAccessRequired && !isAdministrativeUser) {
    redirect('/primeiro-acesso?next=/minha-conta');
  }

  const { data: ownParticipants } = await supabase.from('participants').select('id').eq('user_id', user.id);
  const ownParticipantIds = (ownParticipants ?? []).map((participant) => String(participant.id));
  const { data: openIssues } = ownParticipantIds.length
    ? await supabase.from('participant_data_issues').select('id,resolution_scope,field_code')
      .in('participant_id', ownParticipantIds).eq('status', 'open')
    : { data: [] };
  const requiredUserIssueCount = (openIssues ?? []).filter(isRequiredUserResolvableIssue).length;
  const administrativeIssueCount = (openIssues ?? []).filter(isAdministrativeIssue).length;
  if (requiredUserIssueCount > 0) redirect('/primeiro-acesso/pendencias');

  const [{ data: profileData }, publicPin, sponsorRow] = await Promise.all([
    supabase.rpc('get_customer_profile', { p_user_id: user.id }),
    getMyPublicPin(user.id),
    supabase.from('sponsors').select('id').eq('user_id', user.id).eq('is_active', true).maybeSingle(),
  ]);
  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const isSponsorUser = Boolean(sponsorRow.data);
  const userMetadata = (user.user_metadata as Record<string, unknown> | undefined) ?? null;

  const displayName = resolveParticipantFullName({
    profile,
    userMetadata,
    email: user.email,
  });
  const initials = resolveParticipantInitials(displayName);
  const avatarUrl = resolveParticipantAvatarUrl({
    profile,
    userMetadata,
  });

  return (
    <StoreCartProvider userId={user.id}>
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_var(--brand-glow-1),_transparent_38%),radial-gradient(circle_at_bottom_right,_var(--brand-glow-2),_transparent_45%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 lg:flex-row">
        <aside className="hidden rounded-[2rem] border border-slate-800/80 bg-slate-950/65 p-5 shadow-2xl shadow-black/20 lg:sticky lg:top-6 lg:block lg:h-[calc(100vh-3rem)] lg:w-80 lg:overflow-y-auto">
          <div className="flex items-center gap-3 border-b border-slate-800/80 pb-4">
            <Link href="/" className="flex min-w-0 flex-1 items-center gap-3" title="Voltar ao início">
              <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-2xl bg-black ring-1 ring-(--brand-500)/40 shadow-lg shadow-(--brand-600)/20">
                <div aria-hidden className="mask-logo absolute inset-0.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs uppercase tracking-[0.24em] text-(--brand-300)">Militrin</p>
                <h1 className="text-xl font-semibold">Minha conta</h1>
              </div>
            </Link>
            <CartHeaderLink />
          </div>

          <div className="mt-4 rounded-2xl bg-slate-900/60 p-3 text-sm text-slate-300">
            <div className="flex min-w-0 items-center gap-2.5">
              <MilitrinAvatar src={avatarUrl} alt={`Foto do usuário ${displayName}`} initials={initials} size="sm" />
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100" title={displayName} aria-label={displayName}>{displayName}</p>
                <p className="truncate text-xs text-slate-400" title={String(user.email ?? '')}>{String(user.email ?? '')}</p>
              </div>
            </div>
            {publicPin ? <PublicPinCopy publicPin={publicPin} /> : null}
          </div>

          <AccountSidebarNav administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} />

          <div className="mt-5">
            <p className="px-2 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Futuro</p>
            <div className="space-y-0.5 text-sm">
              {futureNavigation.map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center justify-between rounded-xl px-3.5 py-2.5 text-slate-300 transition hover:bg-slate-900/70 hover:text-slate-100"
                  >
                    <span className="flex items-center gap-3">
                      <Icon size={16} />
                      {item.label}
                    </span>
                    <ArrowRight size={13} className="text-slate-500" />
                  </Link>
                );
              })}
            </div>
          </div>

          <form action={signOutAccountAction} className="mt-5">
            <button type="submit" className="flex h-11 w-full items-center justify-center gap-2 rounded-2xl border border-rose-500/30 bg-rose-500/10 text-sm font-medium text-rose-200 transition hover:bg-rose-500/20">
              <LogOut size={16} />
              Sair
            </button>
          </form>
        </aside>

        <div className="flex-1 pb-[calc(5rem+var(--safe-bottom))] lg:pb-0">
          {administrativeIssueCount > 0 ? (
            <div className="mb-4 flex gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-100">
              <AlertTriangle className="mt-0.5 shrink-0" size={18} />
              <div>
                <p className="font-semibold">Cadastro em análise</p>
                <p className="mt-1 text-sm text-amber-100/80">{administrativeIssueCount} pendência(s) administrativa(s) aguardam conferência do organizador. O acesso à sua conta permanece disponível.</p>
              </div>
            </div>
          ) : null}
          {children}
        </div>
      </div>

      <AccountMobileNav administrativeLandingPage={administrativeLandingPage} isSponsorUser={isSponsorUser} />
    </main>
    </StoreCartProvider>
  );
}
