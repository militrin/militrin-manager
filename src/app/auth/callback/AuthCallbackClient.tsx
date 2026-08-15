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

function safeFirstAccessDestination(value: string | null) {
  const safe = sanitizeInternalNextPath(value, '/primeiro-acesso');
  return safe === '/primeiro-acesso' || safe.startsWith('/primeiro-acesso?') ? safe : '/primeiro-acesso';
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
    return (
      <section className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-slate-900 p-6 text-center">
        <h1 className="text-xl font-semibold">Não foi possível validar o convite</h1>
        <p className="mt-2 text-sm text-rose-200">{errorMessage}</p>
        <p className="mt-3 text-xs text-slate-400">Peça ao organizador responsável pelo seu cadastro que envie um novo link.</p>
        <a href="mailto:?subject=Solicitar%20novo%20convite%20de%20primeiro%20acesso" className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm">Solicitar novo convite</a>
      </section>
    );
  }

  return <p className="text-sm text-slate-300" role="status">Validando convite...</p>;
}
