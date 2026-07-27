'use client';

import { useState } from 'react';

type AdminConfirmDialogProps = {
  label: string;
  title: string;
  description: string;
  onConfirm: () => Promise<void>;
  disabled?: boolean;
};

export function AdminConfirmDialog({ label, title, description, onConfirm, disabled }: AdminConfirmDialogProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-200 disabled:opacity-50"
      >
        {label}
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5">
            <h3 className="text-lg font-semibold text-white">{title}</h3>
            <p className="mt-2 text-sm text-slate-300">{description}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setOpen(false)} className="rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  setLoading(true);
                  try {
                    await onConfirm();
                    setOpen(false);
                  } finally {
                    setLoading(false);
                  }
                }}
                className="rounded-xl bg-emerald-400 px-3 py-2 text-xs font-semibold text-slate-950"
              >
                {loading ? 'Confirmando...' : 'Confirmar'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
