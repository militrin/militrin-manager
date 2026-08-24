import { AdminDataTable } from "./AdminDataTable";

type ReportColumn = { key: string; label: string; align?: "left" | "right" };

type ReportDataTableProps = {
  columns: ReportColumn[];
  rows: Array<Record<string, string | number | null>>;
};

export function ReportDataTable({ columns, rows }: ReportDataTableProps) {
  if (rows.length === 0) {
    return <div className="rounded-2xl border border-dashed border-slate-700 py-10 text-center text-sm text-slate-400">Nenhum dado encontrado para os filtros selecionados.</div>;
  }

  return (
    <>
      {/* Desktop/tablet largo: tabela completa. Abaixo de lg (mesmo corte usado
          em /cadastros e /operacoes) uma tabela larga vira scroll horizontal
          inutilizavel no celular -- por isso os mesmos dados viram cards
          empilhados abaixo, e a tabela some via "hidden lg:block". */}
      <div className="hidden lg:block">
        <AdminDataTable>
          <thead className="bg-slate-950/70 text-left text-slate-400">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className={`px-4 py-3 text-xs font-medium uppercase tracking-widest ${column.align === "right" ? "text-right" : "text-left"}`}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
            {rows.map((row, index) => (
              <tr key={index}>
                {columns.map((column) => (
                  <td key={column.key} className={`px-4 py-2.5 ${column.align === "right" ? "text-right" : "text-left"}`}>
                    {row[column.key] ?? "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </AdminDataTable>
      </div>

      <div className="space-y-2 lg:hidden">
        {rows.map((row, index) => (
          <div key={index} className="rounded-xl border border-slate-800 bg-slate-900/60 p-3 text-sm">
            <dl className="space-y-1.5">
              {columns.map((column) => (
                <div key={column.key} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-xs uppercase tracking-wide text-slate-500">{column.label}</dt>
                  <dd className="truncate text-right text-slate-200">{row[column.key] ?? "-"}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </>
  );
}
