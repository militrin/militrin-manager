import { AdminStatusBadge } from './AdminStatusBadge';

export type AdminTimelineItem = {
  id: string;
  title: string;
  description?: string;
  date?: string;
  status?: string;
};

export function AdminActivityTimeline({ items }: { items: AdminTimelineItem[] }) {
  return (
    <ol className="relative ml-2 border-l border-slate-700 pl-4">
      {items.map((item) => (
        <li key={item.id} className="mb-4">
          <span aria-hidden="true" className="absolute -left-1 mt-2 h-2.5 w-2.5 rounded-full bg-emerald-400" />
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-slate-100">{item.title}</p>
              {item.status ? <AdminStatusBadge status={item.status} /> : null}
            </div>
            {item.description ? <p className="mt-1 text-sm text-slate-300">{item.description}</p> : null}
            {item.date ? <p className="mt-1 text-xs text-slate-400">{item.date}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
