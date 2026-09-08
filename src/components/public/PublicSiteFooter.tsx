import Link from 'next/link';
import { militrinTokens } from '@/components/militrin/tokens';
import { cx } from '@/components/militrin/utils';
import { DATA_DELETION_PATH, PRIVACY_POLICY_PATH } from '@/lib/public/legal';

export function PublicSiteFooter() {
  return (
    <footer className="mx-auto mt-8 w-full max-w-6xl px-1 pb-2">
      <nav
        aria-label="Informações legais"
        className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 border-t border-slate-800/80 pt-4 text-xs text-slate-500"
      >
        <Link
          href={PRIVACY_POLICY_PATH}
          className={cx('rounded-sm transition hover:text-slate-300', militrinTokens.focusRing)}
        >
          Política de Privacidade
        </Link>
        <Link
          href={DATA_DELETION_PATH}
          className={cx('rounded-sm transition hover:text-slate-300', militrinTokens.focusRing)}
        >
          Exclusão de Dados
        </Link>
      </nav>
    </footer>
  );
}
