import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';
import { militrinButtonSize, militrinButtonVariant, militrinTokens } from './tokens';

export type MilitrinButtonVariant = keyof typeof militrinButtonVariant;
export type MilitrinButtonSize = keyof typeof militrinButtonSize;

type MilitrinButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: MilitrinButtonVariant;
  size?: MilitrinButtonSize;
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
        militrinButtonVariant[variant],
        militrinButtonSize[size],
        className,
      )}
    >
      {loading ? <span aria-hidden="true" className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent" /> : iconLeft}
      <span>{children}</span>
      {iconRight}
    </button>
  );
}
