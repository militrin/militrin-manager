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
