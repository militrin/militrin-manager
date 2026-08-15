import { Suspense } from 'react';
import { AuthCallbackClient } from './AuthCallbackClient';

export default function AuthCallbackPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <Suspense fallback={<p className="text-sm text-slate-300">Validando convite...</p>}>
        <AuthCallbackClient />
      </Suspense>
    </main>
  );
}
