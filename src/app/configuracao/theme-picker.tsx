'use client';

import { useState, useTransition } from 'react';
import { Check } from 'lucide-react';
import { BRAND_THEME_IDS, BRAND_THEMES, BrandThemeId } from '@/lib/theme/brand-themes';
import { updatePlatformThemeAction } from './actions';

export function ThemePicker({ initialTheme }: { initialTheme: BrandThemeId }) {
  const [selected, setSelected] = useState<BrandThemeId>(initialTheme);
  const [isPending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<'idle' | 'saved' | 'error'>('idle');

  function choose(theme: BrandThemeId) {
    if (theme === selected) return;
    setSelected(theme);
    setFeedback('idle');
    startTransition(async () => {
      const result = await updatePlatformThemeAction(theme);
      setFeedback(result.success ? 'saved' : 'error');
    });
  }

  return (
    <div>
      <div className="grid grid-cols-4 gap-3 sm:grid-cols-6 lg:grid-cols-9">
        {BRAND_THEME_IDS.map((id) => {
          const theme = BRAND_THEMES[id];
          const isSelected = id === selected;
          return (
            <button
              key={id}
              type="button"
              disabled={isPending}
              onClick={() => choose(id)}
              className="flex flex-col items-center gap-2 rounded-2xl border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300 transition hover:border-slate-600 disabled:opacity-60"
              aria-pressed={isSelected}
            >
              <span
                className="flex h-10 w-10 items-center justify-center rounded-full ring-2 ring-offset-2 ring-offset-slate-950"
                style={{ backgroundColor: theme.swatch, ['--tw-ring-color' as string]: isSelected ? theme.swatch : 'transparent' }}
              >
                {isSelected ? <Check size={16} className="text-white" /> : null}
              </span>
              {theme.label}
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-slate-500">
        {isPending ? 'Salvando...' : feedback === 'saved' ? 'Cor da marca atualizada.' : feedback === 'error' ? 'Não foi possível salvar. Tente novamente.' : 'Aplica-se a todo o sistema (painel e portal do participante).'}
      </p>
    </div>
  );
}
