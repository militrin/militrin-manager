export const militrinTokens = {
  surface: 'bg-slate-900/70 border border-slate-800/80',
  surfaceMuted: 'bg-slate-950/60 border border-slate-800',
  radius: 'rounded-[2rem]',
  radiusMd: 'rounded-2xl',
  radiusSm: 'rounded-xl',
  shadow: 'shadow-lg shadow-black/10',
  title: 'text-white font-semibold',
  text: 'text-slate-200',
  textMuted: 'text-slate-300',
  eyebrow: 'text-xs uppercase tracking-[0.22em] text-(--brand-300)',
  focusRing: 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--brand-400)/80 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950',
};

export const militrinStatusTone = {
  neutral: 'border-slate-600/60 bg-slate-800/40 text-slate-200',
  success: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200',
  warning: 'border-amber-500/40 bg-amber-500/10 text-amber-200',
  danger: 'border-rose-500/40 bg-rose-500/10 text-rose-200',
  info: 'border-sky-500/40 bg-sky-500/10 text-sky-200',
} as const;

/**
 * Escala tipografica unica do produto -- criada durante o refinamento visual
 * de Minha Conta/Home (auditoria encontrou o mesmo nivel visual --
 * ex.: "titulo de secao" -- resolvido com 3-4 combinacoes diferentes de
 * tamanho/peso/tracking espalhadas pelas paginas). Cada chave e um NIVEL de
 * hierarquia (nao um estilo de um componente especifico) -- reutilizavel em
 * qualquer tela, nao so Home. Nao substitui classes ja usadas em paginas nao
 * tocadas por esta rodada; migracao e incremental conforme cada tela for
 * revisada.
 */
export const militrinType = {
  /** Titulo de pagina (1 por tela, ex.: MilitrinPageHeader). */
  pageTitle: 'text-2xl font-semibold tracking-tight text-white sm:text-[1.75rem]',
  /** Titulo de secao dentro da pagina (cabecalho de um bloco/card grande). */
  sectionTitle: 'text-base font-semibold text-white sm:text-lg',
  /** Titulo de um card individual dentro de uma lista/grid. */
  cardTitle: 'text-base font-semibold text-white',
  /** Corpo padrao. */
  body: 'text-sm text-slate-200',
  /** Corpo com enfase reduzida (informacao secundaria, ainda legivel como frase). */
  bodyMuted: 'text-sm text-slate-400',
  /** Microtexto: timestamps, contagens, notas de rodape de card. */
  micro: 'text-xs text-slate-400',
  /** Rotulo/eyebrow em caixa alta (cabecalho de grupo, categoria de dado). */
  label: 'text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500',
  /** Valor numerico em destaque (contadores, indicadores). */
  value: 'text-lg font-semibold text-white tabular-nums',
  /** Valor monetario em destaque -- sempre a cor de sucesso (nunca a cor de marca, que muda por organizacao). */
  money: 'font-semibold text-emerald-300 tabular-nums',
} as const;

/** Mapas de variante/tamanho do botao -- unica fonte, usada por MilitrinButton (<button>) e MilitrinLinkButton (<Link>) pra nunca duas escalas de botao divergentes. */
export const militrinButtonVariant = {
  primary: 'bg-gradient-to-r from-(--brand-600) to-(--brand-500) text-white shadow-lg shadow-(--brand-600)/25 hover:from-(--brand-500) hover:to-(--brand-400)',
  secondary: 'border border-slate-700 bg-slate-900/70 text-slate-100 hover:border-slate-500',
  success: 'border border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/20',
  warning: 'border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20',
  danger: 'border border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20',
  ghost: 'text-slate-200 hover:bg-slate-800/70',
} as const;

export const militrinButtonSize = {
  sm: 'h-9 px-3 text-xs',
  md: 'h-11 px-4 text-sm',
  lg: 'h-12 px-5 text-base',
} as const;
