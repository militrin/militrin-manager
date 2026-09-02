'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@supabase/ssr';
import type { EmailOtpType } from '@supabase/supabase-js';
import { safeAuthDestination } from '@/lib/auth/callback-destinations';
import {
  buildInviteErrorCopy,
  categorizeInviteError,
  logSanitizedAuthLinkFailure,
  type InviteErrorCategory,
  type InviteLinkKind,
} from '@/lib/auth/invite-error-copy';

const CALLBACK_TIMEOUT_MS = 10_000;
const allowedOtpTypes = new Set<EmailOtpType>(['invite', 'signup', 'magiclink', 'recovery', 'email_change', 'email']);

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), CALLBACK_TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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

function linkKindFromParams(otpTypeParam: string | null, nextParam: string | null, kindParam: string | null): InviteLinkKind {
  if (kindParam === 'recovery' || kindParam === 'signup' || kindParam === 'magiclink' || kindParam === 'invite') return kindParam;
  if (otpTypeParam === 'recovery' || (nextParam ?? '').startsWith('/redefinir-senha')) return 'recovery';
  if (otpTypeParam === 'signup' || otpTypeParam === 'email') return 'signup';
  if (otpTypeParam === 'magiclink') return 'magiclink';
  return 'invite';
}

export function AuthCallbackClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const startedRef = useRef(false);
  const mountedRef = useRef(false);

  // /auth/confirm (servidor, caminho oficial recomendado pelo Supabase pra
  // SSR com token_hash/verifyOtp -- nunca depende de PKCE code verifier
  // local, entao funciona em qualquer navegador/dispositivo) ja tentou
  // validar o link e redirecionou pra ca so quando falhou. Calculado direto
  // no corpo do componente (nunca setState dentro de efeito) pra virar o
  // valor inicial do estado abaixo -- o efeito nunca tenta um segundo
  // exchange quando isto ja veio preenchido pela URL.
  const linkErrorParam = searchParams.get('linkError');
  const initialErrorCopy = linkErrorParam
    ? buildInviteErrorCopy(linkErrorParam as InviteErrorCategory, linkKindFromParams(null, null, searchParams.get('kind')))
    : null;
  const [errorCopy, setErrorCopy] = useState<ReturnType<typeof buildInviteErrorCopy> | null>(initialErrorCopy);

  useEffect(() => {
    mountedRef.current = true;

    if (linkErrorParam) {
      return () => { mountedRef.current = false; };
    }

    if (startedRef.current) return () => { mountedRef.current = false; };
    startedRef.current = true;
    let reachedTerminalState = false;

    async function establishSession() {
      const supabase = createCallbackClient();
      const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
      const code = searchParams.get('code');
      const tokenHash = searchParams.get('token_hash');
      const otpType = searchParams.get('type');
      const accessToken = hashParams.get('access_token');
      const refreshToken = hashParams.get('refresh_token');
      const suppliedError = searchParams.get('error_description') ?? searchParams.get('error')
        ?? hashParams.get('error_description') ?? hashParams.get('error');
      const kind = linkKindFromParams(otpType, searchParams.get('next'), searchParams.get('kind'));
      const destination = safeAuthDestination(searchParams.get('next'), kind === 'recovery' ? '/redefinir-senha' : '/primeiro-acesso');

      // Credentials stay only in local variables while the callback runs and are
      // removed from browser history before any asynchronous authentication call.
      window.history.replaceState(null, '', window.location.pathname);

      if (suppliedError) throw { kind, code: null, message: decodeURIComponent(suppliedError.replace(/\+/g, ' ')) };

      let authError: { message: string; code?: string } | null = null;
      // token_hash (verifyOtp) e' sempre preferido sobre code
      // (exchangeCodeForSession): verifyOtp nunca depende de um PKCE code
      // verifier armazenado localmente -- funciona em qualquer navegador/
      // dispositivo por design. code so e' tentado como fallback legado
      // (ex.: link antigo em cache, ou fluxo OAuth futuro).
      if (tokenHash && otpType && allowedOtpTypes.has(otpType as EmailOtpType)) {
        const result = await withTimeout(supabase.auth.verifyOtp({ token_hash: tokenHash, type: otpType as EmailOtpType }));
        authError = result.error;
      } else if (code) {
        const result = await withTimeout(supabase.auth.exchangeCodeForSession(code));
        authError = result.error;
      } else if (accessToken && refreshToken) {
        const result = await withTimeout(supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken }));
        authError = result.error;
      } else if (tokenHash && otpType) {
        throw { kind, code: null, message: `unsupported_otp_type:${otpType}` };
      } else {
        throw { kind, code: null, message: 'missing_credentials' };
      }

      if (authError) {
        throw { kind, code: authError.code ?? null, message: authError.message };
      }

      const sessionResult = await withTimeout(supabase.auth.getSession());
      if (sessionResult.error) {
        throw { kind, code: sessionResult.error.code ?? null, message: sessionResult.error.message };
      }
      if (!sessionResult.data.session) throw { kind, code: null, message: 'session_not_established' };

      reachedTerminalState = true;
      router.replace(destination);
      router.refresh();
    }

    void establishSession()
      .catch((error: unknown) => {
        reachedTerminalState = true;
        const shaped = error as { kind?: InviteLinkKind; code?: string | null; message?: string };
        const kind = shaped?.kind ?? 'invite';
        const category = categorizeInviteError({ message: shaped?.message, code: shaped?.code ?? null });
        // So a categoria + tipo vao pro log (nunca a mensagem crua do
        // provedor, que pode descrever detalhes internos do fluxo de auth) --
        // o usuario so ve a copy traduzida abaixo.
        logSanitizedAuthLinkFailure({ kind, category, rawCode: shaped?.code ?? null });
        if (mountedRef.current) setErrorCopy(buildInviteErrorCopy(category, kind));
      })
      .finally(() => {
        if (!reachedTerminalState && mountedRef.current) {
          setErrorCopy((current) => current ?? buildInviteErrorCopy('internal', 'invite'));
        }
      });

    return () => { mountedRef.current = false; };
  }, [router, searchParams, linkErrorParam]);

  if (errorCopy) {
    return (
      <section className="w-full max-w-md rounded-3xl border border-rose-500/30 bg-slate-900 p-6 text-center">
        <h1 className="text-xl font-semibold">{errorCopy.title}</h1>
        <p className="mt-2 text-sm text-rose-200">{errorCopy.message}</p>
        <a href={errorCopy.ctaHref} className="mt-5 inline-flex h-10 items-center whitespace-nowrap rounded-xl border border-slate-700 px-4 text-sm">{errorCopy.ctaLabel}</a>
      </section>
    );
  }

  return <p className="text-sm text-slate-300" role="status">Validando link...</p>;
}
