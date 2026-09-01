'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { formatCpf, formatPhone } from '@/lib/validation/registration';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { formatISOToDateBR } from '@/lib/utils/date';
import {
  validateFirstAccessProfile,
  type FirstAccessProfileField,
} from '@/lib/account/first-access-validation';
import type { CompleteFirstAccessResult } from './actions';
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
  const [serverErrors, setServerErrors] = useState<NonNullable<CompleteFirstAccessResult['field_errors']>>({});

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
  const currentValidation = validateFirstAccessProfile({ full_name: fullName, cpf, birth_date: birthDate, gender, phone, email, city });
  const visibleErrors = { ...currentValidation.fieldErrors, ...serverErrors };
  const fieldClass = (field: FirstAccessProfileField) => `h-11 w-full rounded-xl border px-3 ${visibleErrors[field] ? 'border-rose-500 bg-rose-500/5' : editable.has(field) ? 'border-amber-500/50 bg-slate-950' : 'border-emerald-500/20 bg-slate-900/70 text-slate-300'}`;
  const fieldStatus = (field: FirstAccessProfileField) => visibleErrors[field]
    ? <span className="text-xs text-amber-300">Preenchimento necessário</span>
    : <span className="text-xs text-emerald-300">Dado válido</span>;
  const fieldError = (field: FirstAccessProfileField) => visibleErrors[field]
    ? <span className="text-xs text-rose-300" role="alert">{visibleErrors[field]}</span>
    : null;

  function changed(field: keyof NonNullable<CompleteFirstAccessResult['field_errors']>) {
    setMessage(null);
    setServerErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  }

  function onSubmit() {
    setMessage(null);
    setServerErrors({});
    if (!currentValidation.success) {
      setServerErrors(currentValidation.fieldErrors);
      setMessage('Revise os campos destacados para concluir seu cadastro.');
      return;
    }

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
        setServerErrors(result.field_errors ?? {});
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
          <input value={fullName} onChange={(event) => { setFullName(event.target.value); changed('full_name'); }} readOnly={!editable.has('full_name')} required aria-invalid={Boolean(visibleErrors.full_name)} className={fieldClass('full_name')} />
          {fieldError('full_name')}
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>CPF</span>{fieldStatus('cpf')}</span>
          <input value={cpf} onChange={(event) => { setCpf(formatCpf(event.target.value)); changed('cpf'); }} readOnly={!editable.has('cpf')} required inputMode="numeric" aria-invalid={Boolean(visibleErrors.cpf)} className={fieldClass('cpf')} />
          {fieldError('cpf')}
        </label>

        <div><div className="mb-1 flex items-center justify-between gap-2 text-sm"><span>Data de nascimento</span>{fieldStatus('birth_date')}</div><BirthDateInput name="birth_date" value={birthDate} onChange={(value) => { setBirthDate(value); changed('birth_date'); }} disabled={!editable.has('birth_date')} required error={visibleErrors.birth_date} label="" /></div>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>Gênero</span>{fieldStatus('gender')}</span>
          <select value={gender} onChange={(event) => { setGender(event.target.value); changed('gender'); }} disabled={!editable.has('gender')} required aria-invalid={Boolean(visibleErrors.gender)} className={fieldClass('gender')}>
            <option value="">Selecione</option>
            <option value="male">Masculino</option>
            <option value="female">Feminino</option>
            <option value="other">Outro</option>
            <option value="prefer_not_to_say">Prefiro não informar</option>
          </select>
          {fieldError('gender')}
        </label>

        <label className="space-y-1 text-sm text-slate-300">
          <span className="flex items-center justify-between gap-2"><span>Telefone</span>{fieldStatus('phone')}</span>
          <input value={phone} onChange={(event) => { setPhone(formatPhone(event.target.value)); changed('phone'); }} readOnly={!editable.has('phone')} required inputMode="numeric" aria-invalid={Boolean(visibleErrors.phone)} className={fieldClass('phone')} />
          {fieldError('phone')}
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span className="flex items-center justify-between gap-2"><span>E-mail</span><span className="text-xs text-emerald-300">Confirmado pela conta</span></span>
          <input type="email" value={email} readOnly required className={fieldClass('email')} />
          {fieldError('email')}
        </label>

        <label className="space-y-1 text-sm text-slate-300 md:col-span-2">
          <span className="flex items-center justify-between gap-2"><span>Cidade</span>{fieldStatus('city')}</span>
          <input value={city} onChange={(event) => { setCity(event.target.value); changed('city'); }} readOnly={!editable.has('city')} required aria-invalid={Boolean(visibleErrors.city)} className={fieldClass('city')} />
          {fieldError('city')}
        </label>
      </div>

      {mustChangePassword ? (
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm text-slate-300">
            <span>Nova senha</span>
            <input value={newPassword} onChange={(event) => { setNewPassword(event.target.value); changed('new_password'); }} type="password" minLength={8} required aria-invalid={Boolean(serverErrors.new_password)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
            {serverErrors.new_password ? <span className="text-xs text-rose-300" role="alert">{serverErrors.new_password}</span> : null}
          </label>

          <label className="space-y-1 text-sm text-slate-300">
            <span>Confirmar senha</span>
            <input value={confirmPassword} onChange={(event) => { setConfirmPassword(event.target.value); changed('confirm_password'); }} type="password" minLength={8} required aria-invalid={Boolean(serverErrors.confirm_password)} className="h-11 w-full rounded-xl border border-slate-700 bg-slate-950 px-3" />
            {serverErrors.confirm_password ? <span className="text-xs text-rose-300" role="alert">{serverErrors.confirm_password}</span> : null}
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
