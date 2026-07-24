type ChartPoint = {
  label: string;
  value: number;
};

type RegistrationChartProps = {
  data: ChartPoint[];
};

export function RegistrationChart({ data }: RegistrationChartProps) {
  const maxValue = Math.max(...data.map((item) => item.value));

  return (
    <div className="flex items-end gap-3 rounded-2xl border border-slate-800/80 bg-slate-950/60 p-4">
      {data.map((item) => (
        <div key={item.label} className="flex flex-1 flex-col items-center gap-3">
          <div className="flex h-40 w-full items-end rounded-2xl bg-slate-900 p-2">
            <div
              className="w-full rounded-xl bg-gradient-to-t from-emerald-500 to-cyan-400"
              style={{ height: `${(item.value / maxValue) * 100}%` }}
            />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium text-slate-200">{item.label}</p>
            <p className="text-xs text-slate-500">{item.value} inscr.</p>
          </div>
        </div>
      ))}
    </div>
  );
}
