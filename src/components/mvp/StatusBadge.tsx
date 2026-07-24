type StatusBadgeProps = {
  label: string;
  tone?: "emerald" | "amber" | "red" | "slate" | "cyan";
};

const tones = {
  emerald: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  amber: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  red: "bg-red-500/15 text-red-300 border-red-500/30",
  slate: "bg-slate-700/60 text-slate-300 border-slate-600",
  cyan: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30",
};

export function StatusBadge({ label, tone = "slate" }: StatusBadgeProps) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${tones[tone]}`}>{label}</span>;
}
