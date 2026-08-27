import Image from 'next/image';
import { cx } from './utils';

type MilitrinEventArtworkProps = {
  src?: string | null;
  alt?: string;
  className?: string;
  emptyLabel?: string;
  /** Quando true, nao renderiza nada (nem placeholder) se `src` for nulo -- usado nas telas publicas, onde uma caixa "Sem banner" pareceria quebrado. */
  hideWhenEmpty?: boolean;
  children?: React.ReactNode;
};

// Padrao oficial de arte de evento (auditoria P0 "cortes de banner"): 16:9,
// sempre via CSS aspect-ratio (nunca altura fixa em px) para que a fracao
// cortada pelo object-cover seja IGUAL em qualquer largura de tela -- o
// bug original era altura fixa + largura fluida, que corta uma fatia
// diferente da imagem em cada breakpoint. Reaproveitado em toda tela
// publica, Minha Conta e admin que exibe banner_hero_url/banner_card_url.
export function MilitrinEventArtwork({ src, alt = '', className, emptyLabel = 'Sem banner', hideWhenEmpty = false, children }: MilitrinEventArtworkProps) {
  if (!src && hideWhenEmpty) return null;

  return (
    <div className={cx('relative aspect-video w-full overflow-hidden bg-slate-900', className)}>
      {src ? (
        <Image src={src} alt={alt} fill unoptimized className="object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-slate-600">{emptyLabel}</div>
      )}
      {children}
    </div>
  );
}
