'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatCpf, formatPhone } from '@/lib/validation/registration';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { formatISOToDateBR } from '@/lib/utils/date';
import { completeFirstAccessAction } from './actions';

type FirstAccessFormProps = {
  initialValues: {
    full_name: string;
    cpf: string;
    birth_date: string;
    gender: string;
    phone: string;
    email: string;
    city: string;
  };
  mustChangePassword: boolean;
  nextPath: string;
};

export function FirstAccessForm({ initialValues, mustChangePassword, nextPath }: FirstAccessFormProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  const [fullName, setFullName] = useState(initialValues.full_name);
  const [cpf, setCpf] = useState(formatCpf(initialValues.cpf));
  const [birthDate, setBirthDate] = useState(initialValues.birth_date ? formatISOToDateBR(initialValues.birth_date) : '');
  const [gender, setGender] = useState(initialValues.gender);
  const [phone, setPhone] = useState(formatPhone(initialValues.phone));
  const [email] = useState(initialValues.email);
  const [city, setCity] = useState(initialValues.city);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  function onSubmit() {
    setMessage(null);

    const formData = new FormData();
    formData.set('full_name', fullName);
    formData.set('cpf', cpf);
    formData.set('birth_date', birthDate);
    formData.set('gender', gender);
    formData.set('phone', phone);
    formData.set('email', email);
    formData.set('city', city);
    formData.set('next_path', nextPath);
    if (mustChangePassword) {
      formData.set('new_password', newPassword);
      formData.set('confirm_password', confirmPassword);
    }

    startTransition(async () => {
      const result = await completeFirstAccessAction(formData);
      if (!result.success) {
        setMessage(result.message);
        return;
      }

      router.push(result.redirect_to || '/minha-conta');
    });
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isPending) return;
        onSubmit();
      }}
      className="mt-6 space-y-4"
    >
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-sm text-slate-300">
          <span>Nome completo</span>
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>CPF</span>
          <input value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} required inputMode="numeric" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <BirthDateInput name="birth_date" value={birthDate} onChange={setBirthDate} required label="Data de nascimento" />

        <label className="space-y-1 text-sm text-slate-300">
          <span>Gênero</span>
          <select value={gender} onChange={(event) => setGender(event.target.value)} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3">
            <option value="">Selecione</option>
            <option value="male">Masculino</option>
            <option value="female">Feminino</option>
            <option value="other">Outro</option>
            <option value="prefer_not_to_say">Prefiro não informar</option>
          </select>
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span>Telefone</span>
          <input value={phone} onChange={(event) => setPhone(formatPhone(event.target.value))} required inputMode="numeric" className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span>E-mail</span>
          <input type="email" value={email} readOnly required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 opacity-80" />
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span>Cidade</span>
          <input value={city} onChange={(event) => setCity(event.target.value)} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
        </label>
      </div>

      {mustChangePassword ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm text-slate-300">
            <span>Nova senha</span>
            <input value={newPassword} onChange={(event) => setNewPassword(event.target.value)} type="password" minLength={8} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
          </label>

          <label className="space-y-1 text-sm text-slate-300">
            <span>Confirmar senha</span>
            <input value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} type="password" minLength={8} required className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
          </label>
        </div>
      ) : null}

      {mustChangePassword ? (
        <p className="text-xs text-slate-400">A senha precisa ter no mínimo 8 caracteres e não pode ser igual ao CPF.</p>
      ) : null}

      {message ? <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">{message}</p> : null}

      <button type="submit" disabled={isPending} className="h-11 rounded-xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 disabled:opacity-60">
        {isPending ? 'Salvando cadastro...' : 'Concluir cadastro'}
      </button>
    </form>
  );
}
