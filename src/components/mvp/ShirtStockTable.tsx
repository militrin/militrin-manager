type ShirtStockRow = {
  event_name: string | null;
  shirt_type: string;
  shirt_size: string;
  total_quantity: number;
  reserved_quantity: number;
  delivered_quantity: number;
  available: number;
};

type ShirtStockTableProps = {
  rows: ShirtStockRow[];
};

export function ShirtStockTable({ rows }: ShirtStockTableProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-800/80">
      <table className="min-w-full divide-y divide-slate-800 text-sm">
        <thead className="bg-slate-950/70 text-left text-slate-400">
          <tr>
            <th className="px-4 py-3 font-medium">Evento</th>
            <th className="px-4 py-3 font-medium">Modelo</th>
            <th className="px-4 py-3 font-medium">Tamanho</th>
            <th className="px-4 py-3 font-medium">Total</th>
            <th className="px-4 py-3 font-medium">Reservadas</th>
            <th className="px-4 py-3 font-medium">Entregues</th>
            <th className="px-4 py-3 font-medium">Disponíveis</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-800 bg-slate-900/60 text-slate-200">
          {rows.map((row) => (
            <tr key={`${row.event_name ?? "event"}-${row.shirt_type}-${row.shirt_size}`}>
              <td className="px-4 py-3">{row.event_name ?? "—"}</td>
              <td className="px-4 py-3">{row.shirt_type}</td>
              <td className="px-4 py-3">{row.shirt_size}</td>
              <td className="px-4 py-3">{row.total_quantity}</td>
              <td className="px-4 py-3">{row.reserved_quantity}</td>
              <td className="px-4 py-3">{row.delivered_quantity}</td>
              <td className="px-4 py-3">{row.available}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
