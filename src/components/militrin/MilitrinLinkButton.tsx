import Link, { type LinkProps } from 'next/link';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';
import { militrinButtonSize, militrinButtonVariant, militrinTokens } from './tokens';
import type { MilitrinButtonSize, MilitrinButtonVariant } from './MilitrinButton';

type MilitrinLinkButtonProps = LinkProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof LinkProps | 'href'> & {
    variant?: MilitrinButtonVariant;
    size?: MilitrinButtonSize;
    iconLeft?: ReactNode;
    iconRight?: ReactNode;
  };

/**
 * Mesma escala visual de MilitrinButton (altura, raio, variantes de cor,
 * foco), so que renderiza um <Link> em vez de <button> -- pra CTAs de
 * navegacao ("Ver ingresso", "Continuar pagamento") pararem de reimplementar
 * as mesmas classes com pequenas divergencias em cada tela.
 */
export function MilitrinLinkButton({
  className,
  variant = 'primary',
  size = 'md',
  iconLeft,
  iconRight,
  children,
  ...rest
}: MilitrinLinkButtonProps) {
  return (
    <Link
      {...rest}
      className={cx(
        'inline-flex items-center justify-center gap-2 rounded-2xl font-semibold transition',
        militrinTokens.focusRing,
        militrinButtonVariant[variant],
        militrinButtonSize[size],
        className,
      )}
    >
      {iconLeft}
      <span>{children}</span>
      {iconRight}
    </Link>
  );
}
