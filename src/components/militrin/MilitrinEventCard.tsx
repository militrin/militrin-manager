import type { ReactNode } from 'react';
import { MilitrinCard } from './MilitrinCard';

type MilitrinEventCardProps = {
  name: string;
  date: string;
  location: string;
  registrationStatus: string;
  action?: ReactNode;
};

export function MilitrinEventCard({ name, date, location, registrationStatus, action }: MilitrinEventCardProps) {
  return (
    <MilitrinCard className="p-5">
      <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Proximo evento</p>
      <h3 className="mt-2 text-2xl font-semibold text-white">{name}</h3>
      <p className="mt-2 text-sm text-slate-300">{date}</p>
      <p className="text-sm text-slate-300">{location}</p>
      <p className="mt-2 text-xs uppercase tracking-wide text-slate-400">Inscricao: {registrationStatus}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </MilitrinCard>
  );
}
