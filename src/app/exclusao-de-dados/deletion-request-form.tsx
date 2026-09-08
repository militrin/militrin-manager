'use client';

import { useRef, useState } from 'react';
import { MilitrinButton } from '@/components/militrin';
import { militrinTokens } from '@/components/militrin/tokens';
import { cx } from '@/components/militrin/utils';
import { submitDataDeletionRequestAction } from './actions';

const inputClassName =
  'h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none transition focus:border-emerald-400';

export function DataDeletionRequestForm() {
  const submitLockRef = useRef(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [instagramHandle, setInstagramHandle] = useState('');
  const [notes, setNotes] = useState('');
  const [website, setWebsite] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLockRef.current || isSubmitting || success) return;

    submitLockRef.current = true;
    setIsSubmitting(true);
    setMessage(null);

    try {
      const result = await submitDataDeletionRequestAction({
        fullName,
        email,
        instagramHandle,
        notes,
        confirmed,
        website,
      });

      if (!result.success) {
        setMessage(result.message);
        return;
      }

      setSuccess(true);
      setMessage(result.message);
      setFullName('');
      setEmail('');
      setInstagramHandle('');
      setNotes('');
      setConfirmed(false);
    } catch {
      setMessage('Não foi possível enviar a solicitação agora. Tente novamente em instantes.');
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }

  if (success) {
    return (
      <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-100" role="status">
        <p className="font-semibold text-white">Solicitação enviada</p>
        <p className="mt-2 text-emerald-100/90">
          {message || 'Registramos o seu pedido. Ele será analisado e não provoca exclusão automática de dados.'}
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="relative space-y-4" noValidate>
      <label className="space-y-2 block">
        <span className="text-sm text-slate-200">Nome</span>
        <input
          name="full_name"
          autoComplete="name"
          required
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          className={inputClassName}
        />
      </label>

      <label className="space-y-2 block">
        <span className="text-sm text-slate-200">E-mail</span>
        <input
          type="email"
          name="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={inputClassName}
        />
      </label>

      <label className="space-y-2 block">
        <span className="text-sm text-slate-200">Usuário do Instagram (opcional)</span>
        <input
          name="instagram_handle"
          autoComplete="off"
          placeholder="@usuario, se a solicitação envolver Instagram"
          value={instagramHandle}
          onChange={(event) => setInstagramHandle(event.target.value)}
          className={inputClassName}
        />
      </label>

      <label className="space-y-2 block">
        <span className="text-sm text-slate-200">Motivo ou observações (opcional)</span>
        <textarea
          name="notes"
          rows={4}
          maxLength={2000}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className="w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 py-3 text-slate-100 outline-none transition focus:border-emerald-400"
        />
      </label>

      <div hidden aria-hidden="true">
        <input
          type="text"
          name="company_website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      <label className="flex items-start gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
        <input
          type="checkbox"
          required
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950"
        />
        <span>
          Confirmo que sou a pessoa titular dos dados (ou seu representante) e desejo solicitar a exclusão das
          informações pessoais aplicáveis. Entendo que este envio é uma solicitação e não apaga dados automaticamente.
        </span>
      </label>

      {message ? (
        <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200" role="alert">
          {message}
        </p>
      ) : null}

      <MilitrinButton type="submit" loading={isSubmitting} className={cx('w-full sm:w-auto', militrinTokens.focusRing)}>
        Enviar solicitação
      </MilitrinButton>
    </form>
  );
}
