import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';
import { militrinTokens } from './tokens';

type ButtonVariant = 'primary' | 'secondary' | 'success' | 'warning' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

const variantClass: Record<ButtonVariant, string> = {
  primary: 'bg-gradient-to-r from-(--brand-600) to-(--brand-500) text-white shadow-lg shadow-(--brand-600)/25 hover:from-(--brand-500) hover:to-(--brand-400)',
  secondary: 'border border-slate-700 bg-slate-900/70 text-slate-100 hover:border-slate-500',
  success: 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
  warning: 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20',
  danger: 'border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
  ghost: 'text-slate-200 hover:bg-slate-800/70',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
};

type MilitrinButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
};

export function MilitrinButton({
  className,
  variant = 'primary',
  size = 'md',
  loading = false,
  iconLeft,
  iconRight,
  children,
  disabled,
  ...rest
}: MilitrinButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      {...rest}
      disabled={isDisabled}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-60',
        militrinTokens.focusRing,
        variantClass[variant],
        sizeClass[size],
        className,
      )}
    >
      {loading ? <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> : iconLeft}
      <span>{children}</span>
      {iconRight}
    </button>
  );
}
