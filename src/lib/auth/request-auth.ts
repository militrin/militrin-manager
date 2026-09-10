import { cache } from 'react';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { User } from '@supabase/supabase-js';

type AuthResolution = {
  user: User | null;
  error: { message: string; name?: string; status?: number } | null;
  durationMs: number;
};

type RequestAuthMetrics = {
  authGetUserCount: number;
  permissionRpcCount: number;
  permissionMapMs: number;
  lastAuthMs: number;
  lastAuthOk: boolean;
  lastAuthError: string | null;
};

export const getRequestAuthMetrics = cache((): RequestAuthMetrics => ({
  authGetUserCount: 0,
  permissionRpcCount: 0,
  permissionMapMs: 0,
  lastAuthMs: 0,
  lastAuthOk: false,
  lastAuthError: null,
}));

function getSupabaseAnonKey() {
  return process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
}

export function logRequestAuthMetrics() {
  const metrics = getRequestAuthMetrics();
  console.info(JSON.stringify({
    src: 'auth-permissions',
    auth_get_user_count: metrics.authGetUserCount,
    permission_rpc_count: metrics.permissionRpcCount,
    permission_map_ms: metrics.permissionMapMs,
    auth_get_user_ms: metrics.lastAuthMs,
    auth_ok: metrics.lastAuthOk,
    auth_error: metrics.lastAuthError,
  }));
}

function buildServerClient(cookieStore: Awaited<ReturnType<typeof cookies>>) {
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    getSupabaseAnonKey(),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
          } catch {
            // setAll durante Server Action / render somente-leitura.
          }
        },
      },
    },
  );
}

type ServerClient = ReturnType<typeof buildServerClient>;

type CachedClient = {
  client: ServerClient;
  originalGetUser: ServerClient['auth']['getUser'];
};

const getCachedServerClient = cache(async (): Promise<CachedClient> => {
  const cookieStore = await cookies();
  const client = buildServerClient(cookieStore);
  return { client, originalGetUser: client.auth.getUser.bind(client.auth) };
});

const resolveCurrentUser = cache(async (): Promise<AuthResolution> => {
  const metrics = getRequestAuthMetrics();
  metrics.authGetUserCount += 1;
  const started = Date.now();
  const { originalGetUser } = await getCachedServerClient();
  try {
    const { data, error } = await originalGetUser();
    metrics.lastAuthMs = Date.now() - started;
    metrics.lastAuthOk = Boolean(data.user) && !error;
    metrics.lastAuthError = error
      ? (error.status === 504 || /timeout/i.test(error.message) ? 'timeout' : 'error')
      : null;
    logRequestAuthMetrics();
    return {
      user: data.user ?? null,
      error: error ? { message: error.message, name: error.name, status: error.status } : null,
      durationMs: metrics.lastAuthMs,
    };
  } catch (caught) {
    metrics.lastAuthMs = Date.now() - started;
    metrics.lastAuthOk = false;
    metrics.lastAuthError = 'error';
    logRequestAuthMetrics();
    return {
      user: null,
      error: { message: caught instanceof Error ? caught.message : 'auth_error' },
      durationMs: metrics.lastAuthMs,
    };
  }
});

export async function getCurrentUser() {
  const resolved = await resolveCurrentUser();
  return resolved.user;
}

export async function createServerSupabaseClient(): Promise<ServerClient> {
  const { client, originalGetUser } = await getCachedServerClient();
  client.auth.getUser = (async (...args: Parameters<typeof originalGetUser>) => {
    if (args.length > 0) {
      return originalGetUser(...args);
    }
    const resolved = await resolveCurrentUser();
    return {
      data: { user: resolved.user },
      error: resolved.error as Awaited<ReturnType<typeof originalGetUser>>['error'],
    };
  }) as typeof originalGetUser;
  return client;
}
