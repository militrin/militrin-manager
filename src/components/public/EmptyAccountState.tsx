import Link from 'next/link';

type EmptyAccountStateProps = {
  title: string;
  description: string;
  actionHref?: string;
  actionLabel?: string;
};

export function EmptyAccountState({ title, description, actionHref, actionLabel }: EmptyAccountStateProps) {
  return (
    <section className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
      <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Militrin</p>
      <h2 className="mt-2 text-3xl font-semibold text-white">{title}</h2>
      <p className="mt-2 max-w-2xl text-sm text-slate-300">{description}</p>
      {actionHref && actionLabel ? (
        <Link href={actionHref} className="mt-6 inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
          {actionLabel}
        </Link>
      ) : null}
    </section>
  );
}