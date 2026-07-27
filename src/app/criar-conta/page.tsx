'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { formatCpf, formatPhone } from '@/lib/validation/registration';
import { signUpPublicAccountAction } from '@/app/inscricao/actions';
import { resolvePostAuthDestination } from '@/lib/utils/safe-navigation';

export default function CriarContaPage() {
  const router = useRouter();
  const submitLockRef = useRef(false);
  const [fullName, setFullName] = useState('');
  const [cpf, setCpf] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [gender, setGender] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [city, setCity] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRedirecting, setIsRedirecting] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(null);
  const [cooldownTick, setCooldownTick] = useState(() => Date.now());

  useEffect(() => {
    if (!cooldownUntil) return;

    const timer = window.setInterval(() => setCooldownTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  const cooldownSeconds = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - cooldownTick) / 1000)) : 0;
  const canSubmit = !isSubmitting && !isRedirecting && cooldownSeconds === 0;

  function getWizardPathFromStorage() {
    if (typeof window === 'undefined') return null;
    const saved = window.sessionStorage.getItem('militrin:last-wizard-next');
    return saved?.trim() || null;
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (submitLockRef.current || isSubmitting || cooldownSeconds > 0) {
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    setMessage(null);
    let keepLocked = false;

    try {
      const params = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search);
      const nextPath = params?.get('next') ?? null;
      const wizardPath = getWizardPathFromStorage();
      const fallbackDestination = resolvePostAuthDestination({
        nextPath,
        wizardPath,
        fallback: '/minha-conta',
      });

      const result = await signUpPublicAccountAction({
        full_name: fullName,
        cpf,
        birth_date: birthDate,
        gender,
        phone,
        email,
        city,
        password,
        confirmPassword,
        acceptPrivacy,
        require_profile_fields: true,
        next_path: nextPath,
        wizard_path: wizardPath,
      });

      if (!result.success) {
        if (result.code === 'rate_limit') {
          setCooldownTick(Date.now());
          setCooldownUntil(Date.now() + 60_000);
          setMessage(result.message || 'Muitas solicitações de e-mail foram realizadas em pouco tempo.');
          return;
        }

        if (result.code === 'already_registered') {
          setMessage('Esta conta já existe. Entre com seu e-mail e senha para continuar.');
          return;
        }

        setMessage(result.message || 'Nao foi possivel criar conta.');
        return;
      }

      if (result.authenticated) {
        setMessage(
          result.profile_creation_failed
            ? 'Sua conta foi criada, mas precisamos concluir seus dados.'
            : 'Conta criada com sucesso. Entrando...',
        );
        setIsRedirecting(true);
        keepLocked = true;
        router.push(result.redirect_to || fallbackDestination);
        return;
      }

      if (result.email_confirmation_required) {
        setMessage('Conta criada. Verifique seu e-mail para confirmar o acesso.');
        return;
      }

      setMessage('Conta criada. Verifique seu e-mail para confirmar o acesso.');
    } finally {
      if (!keepLocked) {
        submitLockRef.current = false;
        setIsSubmitting(false);
      }
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto grid w-full max-w-5xl gap-6 lg:grid-cols-[0.95fr_1.05fr]">
        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-950/60 p-6 shadow-2xl shadow-black/20 sm:p-8">
          <p className="text-xs uppercase tracking-[0.24em] text-emerald-300">Militrin</p>
          <h1 className="mt-2 text-3xl font-semibold text-white">Criar minha conta</h1>
          <p className="mt-2 text-sm text-slate-300">Use seu e-mail para acessar ingressos, QR Codes e histórico no Militrin.</p>

          <div className="mt-6 rounded-2xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
            <p className="font-medium text-slate-100">Antes de continuar</p>
            <p className="mt-2">Preencha seus dados exatamente como aparecem no documento e confirme a política de privacidade.</p>
          </div>
        </section>

        <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-2xl shadow-black/20 sm:p-8">
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="space-y-2 sm:col-span-2">
                <span className="text-sm text-slate-300">Nome completo</span>
                <input required value={fullName} onChange={(event) => setFullName(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">CPF</span>
                <input required value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} inputMode="numeric" className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
              </label>

              <BirthDateInput name="birth_date" value={birthDate} onChange={setBirthDate} required label="Nascimento" />

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Gênero</span>
                <select required value={gender} onChange={(event) => setGender(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400">
                  <option value="">Selecione</option>
                  <option value="male">Masculino</option>
                  <option value="female">Feminino</option>
                  <option value="other">Outro</option>
                  <option value="prefer_not_to_say">Prefiro não informar</option>
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Telefone</span>
                <input required value={phone} onChange={(event) => setPhone(formatPhone(event.target.value))} inputMode="numeric" className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
              </label>

              <label className="space-y-2 sm:col-span-2">
                <span className="text-sm text-slate-300">E-mail</span>
                <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
              </label>

              <label className="space-y-2 sm:col-span-2">
                <span className="text-sm text-slate-300">Cidade</span>
                <input required value={city} onChange={(event) => setCity(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Senha</span>
                <div className="flex gap-2">
                  <input type={showPassword ? 'text' : 'password'} required minLength={8} value={password} onChange={(event) => setPassword(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
                  <button type="button" onClick={() => setShowPassword((prev) => !prev)} className="rounded-2xl border border-slate-700 px-4 text-sm text-slate-200">
                    {showPassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
              </label>

              <label className="space-y-2">
                <span className="text-sm text-slate-300">Confirmar senha</span>
                <div className="flex gap-2">
                  <input type={showConfirmPassword ? 'text' : 'password'} required minLength={8} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="h-12 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-slate-100 outline-none focus:border-emerald-400" />
                  <button type="button" onClick={() => setShowConfirmPassword((prev) => !prev)} className="rounded-2xl border border-slate-700 px-4 text-sm text-slate-200">
                    {showConfirmPassword ? 'Ocultar' : 'Mostrar'}
                  </button>
                </div>
              </label>
            </div>

            <label className="flex items-start gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
              <input required type="checkbox" checked={acceptPrivacy} onChange={(event) => setAcceptPrivacy(event.target.checked)} className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950" />
              <span>Aceito a política de privacidade e o uso dos meus dados para gestão da inscrição.</span>
            </label>

            {message ? <p className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</p> : null}

            {cooldownSeconds > 0 ? (
              <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
                Muitas solicitações de e-mail foram realizadas em pouco tempo. Aguarde {cooldownSeconds}s e tente novamente.
              </p>
            ) : null}

            <button type="submit" disabled={!canSubmit} className="h-12 w-full rounded-2xl bg-emerald-400 font-semibold text-slate-950 transition hover:bg-emerald-300 disabled:cursor-not-allowed disabled:opacity-60">
              {isSubmitting ? 'Criando conta...' : cooldownSeconds > 0 ? `Aguarde ${cooldownSeconds}s` : 'Criar minha conta'}
            </button>

            <div className="flex items-center justify-between text-sm">
              <Link href="/entrar" className="text-slate-300 transition hover:text-white">Já tenho conta</Link>
              <Link href="/esqueci-minha-senha" className="text-emerald-300 transition hover:text-emerald-200">Esqueci minha senha</Link>
            </div>
          </form>
        </section>
      </div>
    </main>
  );
}