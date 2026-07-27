import { MilitrinStatusBadge } from './MilitrinStatusBadge';

export type MilitrinTimelineItem = {
  id: string;
  title: string;
  subtitle?: string;
  date?: string;
  status?: string;
};

type MilitrinTimelineProps = {
  items: MilitrinTimelineItem[];
};

export function MilitrinTimeline({ items }: MilitrinTimelineProps) {
  return (
    <ol className="relative ml-2 border-l border-slate-700 pl-4">
      {items.map((item) => (
        <li key={item.id} className="mb-4">
          <span aria-hidden="true" className="absolute -left-[5px] mt-2 h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-white">{item.title}</p>
              {item.status ? <MilitrinStatusBadge status={item.status} /> : null}
            </div>
            {item.subtitle ? <p className="mt-1 text-sm text-slate-300">{item.subtitle}</p> : null}
            {item.date ? <p className="mt-1 text-xs text-slate-400">{item.date}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
