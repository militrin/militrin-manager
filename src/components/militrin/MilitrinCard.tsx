import type { HTMLAttributes } from 'react';
import { cx } from './utils';
import { militrinTokens } from './tokens';

export function MilitrinCard({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={cx(militrinTokens.radiusMd, militrinTokens.surfaceMuted, 'p-4', militrinTokens.shadow, className)} />;
}
