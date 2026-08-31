"use client";

type StrongConfirmModalProps = {
  open: boolean;
  title: string;
  description: string;
  confirmLabel: string;
  tone?: "emerald" | "rose";
  onCancel: () => void;
  onConfirm: () => void;
};

export function StrongConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  tone = "emerald",
  onCancel,
  onConfirm,
}: StrongConfirmModalProps) {
  if (!open) return null;

  const confirmClasses =
    tone === "rose"
      ? "bg-rose-500 text-white hover:bg-rose-400"
      : "bg-emerald-400 text-slate-950 hover:bg-emerald-300";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-2xl">
        <h3 className="text-lg font-semibold text-white">{title}</h3>
        <p className="mt-2 text-sm text-slate-300">{description}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl border border-slate-700 px-3 py-2 text-xs font-medium text-slate-200">
            Cancelar
          </button>
          <button type="button" onClick={onConfirm} className={`rounded-xl px-3 py-2 text-xs font-semibold ${confirmClasses}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
