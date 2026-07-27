import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';
import { militrinTokens } from './tokens';

type MilitrinSectionProps = HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
};

export function MilitrinSection({ eyebrow, title, description, action, className, children, ...rest }: MilitrinSectionProps) {
  return (
    <section className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, 'p-6', className)} {...rest}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          {eyebrow ? <p className={militrinTokens.eyebrow}>{eyebrow}</p> : null}
          <h2 className={cx('mt-2 text-3xl', militrinTokens.title)}>{title}</h2>
          {description ? <p className={cx('mt-2 text-sm', militrinTokens.textMuted)}>{description}</p> : null}
        </div>
        {action}
      </header>
      {children ? <div className="mt-5">{children}</div> : null}
    </section>
  );
}
