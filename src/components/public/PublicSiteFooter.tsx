import Link from 'next/link';
import { cx } from '@/components/militrin/utils';
import {
  DATA_DELETION_PATH,
  getMilitrinContactEmail,
  MILITRIN_INSTAGRAM_HANDLE,
  MILITRIN_INSTAGRAM_URL,
  PRIVACY_POLICY_PATH,
} from '@/lib/public/legal';

const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950';

export function PublicSiteFooter() {
  const contactEmail = getMilitrinContactEmail();

  return (
    <footer className="mx-auto w-full max-w-[1400px] py-8">
      <div className="flex flex-col gap-6 border-t border-white/8 pt-6 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-xl bg-black ring-1 ring-emerald-400/35">
            <div aria-hidden className="mask-logo absolute inset-1 !bg-emerald-400" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-[0.22em] text-white">MILITRIN</p>
            <p className="text-xs text-slate-500">© 2026 Militrin. Todos os direitos reservados.</p>
          </div>
        </div>
        <nav
          aria-label="Informações legais"
          className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-400"
        >
          <Link href={PRIVACY_POLICY_PATH} className={cx('rounded-sm transition hover:text-slate-200', focusRing)}>
            Política de Privacidade
          </Link>
          <Link href={DATA_DELETION_PATH} className={cx('rounded-sm transition hover:text-slate-200', focusRing)}>
            Exclusão de Dados
          </Link>
          <a href={`mailto:${contactEmail}`} className={cx('rounded-sm transition hover:text-slate-200', focusRing)}>
            {contactEmail}
          </a>
          <a
            href={MILITRIN_INSTAGRAM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={cx('rounded-sm transition hover:text-slate-200', focusRing)}
          >
            @{MILITRIN_INSTAGRAM_HANDLE}
          </a>
        </nav>
      </div>
    </footer>
  );
}
