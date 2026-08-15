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
  inviteId?: string;
  editableFields: string[];
};

export function FirstAccessForm({ initialValues, mustChangePassword, nextPath, inviteId, editableFields }: FirstAccessFormProps) {
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
  const editable = new Set(editableFields);
  const fieldClass = (field: string) => `h-11 w-full rounded-xl border px-3 ${editable.has(field) ? 'border-amber-500/50 bg-slate-950' : 'border-emerald-500/20 bg-slate-900/70 text-slate-300'}`;
  const fieldStatus = (field: string) => editable.has(field) ? <span className="text-xs text-amber-300">Preenchimento necessário</span> : <span className="text-xs text-emerald-300">Dado já informado</span>;

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
    if (inviteId) formData.set('invite_id', inviteId);
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
          <span className="flex items-center justify-between gap-2"><span>Nome completo</span>{fieldStatus('full_name')}</span>
          <input value={fullName} onChange={(event) => setFullName(event.target.value)} readOnly={!editable.has('full_name')} required className={fieldClass('full_name')} />
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>CPF</span>{fieldStatus('cpf')}</span>
          <input value={cpf} onChange={(event) => setCpf(formatCpf(event.target.value))} readOnly={!editable.has('cpf')} required inputMode="numeric" className={fieldClass('cpf')} />
        </label>

        <div><div className="mb-1 flex items-center justify-between gap-2 text-sm"><span>Data de nascimento</span>{fieldStatus('birth_date')}</div><BirthDateInput name="birth_date" value={birthDate} onChange={setBirthDate} disabled={!editable.has('birth_date')} required label="" /></div>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>Gênero</span>{fieldStatus('gender')}</span>
          <select value={gender} onChange={(event) => setGender(event.target.value)} disabled={!editable.has('gender')} className={fieldClass('gender')}>
            <option value="">Selecione</option>
            <option value="male">Masculino</option>
            <option value="female">Feminino</option>
            <option value="other">Outro</option>
            <option value="prefer_not_to_say">Prefiro não informar</option>
          </select>
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>Telefone</span>{fieldStatus('phone')}</span>
          <input value={phone} onChange={(event) => setPhone(formatPhone(event.target.value))} readOnly={!editable.has('phone')} required inputMode="numeric" className={fieldClass('phone')} />
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span className="flex items-center justify-between gap-2"><span>E-mail</span><span className="text-xs text-emerald-300">Confirmado pela conta</span></span>
          <input type="email" value={email} readOnly required className={fieldClass('email')} />
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span className="flex items-center justify-between gap-2"><span>Cidade</span>{fieldStatus('city')}</span>
          <input value={city} onChange={(event) => setCity(event.target.value)} readOnly={!editable.has('city')} required className={fieldClass('city')} />
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
