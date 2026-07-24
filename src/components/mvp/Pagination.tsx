type PaginationProps = {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
};

export function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center justify-end gap-2">
      <button
        type="button"
        onClick={() => onPageChange(Math.max(1, page - 1))}
        disabled={page <= 1}
        className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-300 disabled:opacity-50"
      >
        Anterior
      </button>
      <span className="text-sm text-slate-400">Página {page} de {totalPages}</span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        disabled={page >= totalPages}
        className="rounded-xl border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-300 disabled:opacity-50"
      >
        Próxima
      </button>
    </div>
  );
}
