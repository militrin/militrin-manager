'use client';

import { formatBirthDateBRInput } from '@/lib/utils/date';

type BirthDateInputProps = {
  value: string;
  onChange: (value: string) => void;
  name: string;
  required?: boolean;
  disabled?: boolean;
  error?: string;
  label?: string;
  className?: string;
};

export function BirthDateInput({
  value,
  onChange,
  name,
  required = false,
  disabled = false,
  error,
  label = 'Data de nascimento',
  className,
}: BirthDateInputProps) {
  const errorId = `${name}-error`;

  return (
    <label className={className ?? 'space-y-2 text-sm'}>
      <span className="text-slate-300">{label}</span>
      <input
        id={name}
        name={name}
        type="text"
        value={value}
        onChange={(event) => onChange(formatBirthDateBRInput(event.target.value))}
        placeholder="dd/MM/aaaa"
        inputMode="numeric"
        autoComplete="bday"
        maxLength={10}
        required={required}
        disabled={disabled}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? errorId : undefined}
        className="w-full rounded-2xl border border-slate-800 bg-slate-950/70 px-4 py-3 text-slate-100 outline-none"
      />
      {error ? (
        <p id={errorId} className="text-sm text-red-400">
          {error}
        </p>
      ) : null}
    </label>
  );
}
