'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { sanitizeInternalNextPath } from '@/lib/utils/safe-navigation';

const CALLBACK_TIMEOUT_MS = 10_000;
const allowedOtpTypes = new Set<EmailOtpType>(['invite', 'signup', 'magiclink', 'recovery', 'email_change', 'email']);

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('A validação do convite excedeu 10 segundos. Solicite um novo convite.')), CALLBACK_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

// Allowlist explicita de destinos pos-callback -- nunca abrir pra qualquer
// path (sanitizeInternalNextPath so evita open-redirect pra fora do site,
// nao decide se o destino faz sentido aqui). /primeiro-acesso continua o
// default (convites/primeiro acesso); /redefinir-senha e o unico outro
// destino valido hoje (link de recuperacao de senha, ver
// requestPasswordResetAction em src/app/inscricao/actions.ts).
const ALLOWED_CALLBACK_DESTINATION_PREFIXES = ['/primeiro-acesso', '/redefinir-senha'];

function safeFirstAccessDestination(value: string | null) {
  const safe = sanitizeInternalNextPath(value, '/primeiro-acesso');
  const isAllowed = ALLOWED_CALLBACK_DESTINATION_PREFIXES.some(
    (prefix) => safe === prefix || safe.startsWith(`${prefix}?`),
  );
  return isAllowed ? safe : '/primeiro-acesso';
}

function createCallbackClient() {
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ?? '';
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '', anonKey, {
    isSingleton: false,
    auth: { detectSessionInUrl: false },
  });
}

export function AuthCallbackClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const startedRef = useRef(false);
  const mountedRef = useRef(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    if (startedRef.current) return () => { mountedRef.current = false; };
    startedRef.current = true;
    let reachedTerminalState = false;

    async function establishSession() {
      const supabase = createCallbackClient();
      const destination = safeFirstAccessDestination(searchParams.get('next'));
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const code = searchParams.get('code');
      const tokenHash = searchParams.get('token_hash');
      const otpType = searchParams.get('type');
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      const suppliedError = searchParams.get('error_description') ?? searchParams.get('error')
        ?? hashParams.get('error_description') ?? hashParams.get('error');

      // Credentials stay only in local variables while the callback runs and are
      // removed from browser history before any asynchronous authentication call.
      window.history.replaceState(null, '', window.location.pathname);

      if (suppliedError) throw new Error(decodeURIComponent(suppliedError.replace(/\+/g, ' ')));

      let authError: { message: string } | null = null;
      if (code) {
        const result = await withTimeout(supabase.auth.exchangeCodeForSession(code));
        authError = result.error;
      } else if (tokenHash && otpType && allowedOtpTypes.has(otpType as EmailOtpType)) {
        const result = await withTimeout(supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType as EmailOtpType }));
        authError = result.error;
      } else if (accessToken && refreshToken) {
        const result = await withTimeout(supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }));
        authError = result.error;
      } else if (tokenHash && otpType) {
        throw new Error(`Tipo de autenticação não suportado: ${otpType}.`);
      } else {
        throw new Error('O link não contém credenciais válidas de convite. Ele pode ter expirado ou já ter sido utilizado.');
      }

      if (authError) {
        throw new Error(authError.message);
      }

      const sessionResult = await withTimeout(supabase.auth.getSession());
      if (sessionResult.error) {
        throw new Error(sessionResult.error.message);
      }
      if (!sessionResult.data.session) throw new Error('O convite foi validado, mas a sessão não pôde ser criada. Solicite um novo convite.');

      reachedTerminalState = true;
      router.replace(destination);
      router.refresh();
    }

    void establishSession()
      .catch((error: unknown) => {
        reachedTerminalState = true;
        const message = error instanceof Error ? error.message : 'Não foi possível validar o convite.';
        if (mountedRef.current) setErrorMessage(message);
      })
      .finally(() => {
        if (!reachedTerminalState && mountedRef.current) {
          setErrorMessage('Não foi possível concluir a validação do convite. Solicite um novo convite.');
        }
      });

    return () => { mountedRef.current = false; };
  }, [router, searchParams]);

  if (errorMessage) {
    // O mesmo callback processa convite, confirmacao de cadastro e
    // recuperacao de senha (ver ALLOWED_CALLBACK_DESTINATION_PREFIXES) --
    // a copy de erro precisa refletir qual dos tres, nunca falar sempre em
    // "convite" pra um link de recuperacao de senha expirado.
    const otpTypeParam = searchParams.get('type');
    const nextParam = searchParams.get('next') ?? '';
    const linkKind: 'recovery' | 'signup' | 'invite' = otpTypeParam === 'recovery' || nextParam.startsWith('/redefinir-senha')
      ? 'recovery'
      : otpTypeParam === 'signup' || otpTypeParam === 'email'
        ? 'signup'
        : 'invite';

    const copy = linkKind === 'recovery'
      ? { title: 'Não foi possível validar o link de recuperação', hint: 'O link pode ter expirado ou já ter sido usado. Solicite um novo.', ctaLabel: 'Solicitar novo link', ctaHref: '/esqueci-minha-senha' }
      : linkKind === 'signup'
        ? { title: 'Não foi possível validar sua confirmação', hint: 'O link pode ter expirado ou já ter sido usado. Reenvie a confirmação.', ctaLabel: 'Reenviar confirmação', ctaHref: '/verifique-seu-email' }
        : { title: 'Não foi possível validar o convite', hint: 'Peça ao organizador responsável pelo seu cadastro que envie um novo link.', ctaLabel: 'Solicitar novo convite', ctaHref: 'mailto:?subject=Solicitar%20novo%20convite%20de%20primeiro%20acesso' };

    return (
      <section className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-slate-900 p-6 text-center">
        <h1 className="text-xl font-semibold">{copy.title}</h1>
        <p className="mt-2 text-sm text-rose-200">{errorMessage}</p>
        <p className="mt-3 text-xs text-slate-400">{copy.hint}</p>
        <a href={copy.ctaHref} className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm">{copy.ctaLabel}</a>
      </section>
    );
  }

  return <p className="text-sm text-slate-300" role="status">Validando link...</p>;
}
