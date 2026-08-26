import type { HTMLAttributes, ReactNode } from 'react';
import { cx } from './utils';
import { militrinTokens } from './tokens';

type MilitrinSectionProps = HTMLAttributes<HTMLElement> & {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * 'default' (padrao, inalterado): usado hoje por 12+ telas (cabecalho de
   * pagina cheio). 'compact': mesma anatomia (eyebrow/titulo/descricao/acao),
   * densidade reduzida -- pensado para blocos de saudacao/resumo que nao
   * devem dominar a tela (ex.: Home). Nunca aplicado por padrao.
   */
  size?: 'default' | 'compact';
};

export function MilitrinSection({ eyebrow, title, description, action, size = 'default', className, children, ...rest }: MilitrinSectionProps) {
  const compact = size === 'compact';
  return (
    <section className={cx(militrinTokens.radius, militrinTokens.surface, militrinTokens.shadow, compact ? 'p-4 sm:p-5' : 'p-6', className)} {...rest}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {eyebrow ? <p className={militrinTokens.eyebrow}>{eyebrow}</p> : null}
          <h2 className={cx(compact ? 'mt-0.5 text-xl sm:text-2xl' : 'mt-2 text-3xl', militrinTokens.title)}>{title}</h2>
          {description ? <p className={cx(compact ? 'mt-0.5 text-xs' : 'mt-2 text-sm', militrinTokens.textMuted)}>{description}</p> : null}
        </div>
        {action}
      </header>
      {children ? <div className={compact ? 'mt-3' : 'mt-5'}>{children}</div> : null}
    </section>
  );
}
