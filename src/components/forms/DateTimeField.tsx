"use client";

function splitDateTimeLocal(value: string) {
  if (!value) return { date: "", time: "" };
  const [date, time] = value.split("T");
  return { date: date ?? "", time: (time ?? "").slice(0, 5) };
}

function joinDateTimeLocal(date: string, time: string) {
  if (!date) return "";
  return `${date}T${time || "00:00"}`;
}

const inputClass = "w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2";
const timeInputClass = "w-28 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2";

export function DateTimeField({
  label,
  value,
  onChange,
  className,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  const parts = splitDateTimeLocal(value);
  return (
    <div className={className ?? "space-y-1 text-sm"}>
      <span className="text-slate-300">{label}</span>
      <div className="flex gap-2">
        <input
          type="date"
          lang="pt-BR"
          value={parts.date}
          onChange={(event) => onChange(joinDateTimeLocal(event.target.value, parts.time))}
          className={inputClass}
        />
        <input
          type="time"
          lang="pt-BR"
          value={parts.time}
          onChange={(event) => onChange(joinDateTimeLocal(parts.date, event.target.value))}
          className={timeInputClass}
        />
      </div>
    </div>
  );
}
