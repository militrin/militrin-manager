'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { SlideOverPanel } from '@/components/admin/SlideOverPanel';
import {
  INTEGRITY_DOMAIN_LABELS,
  INTEGRITY_SEVERITY_LABELS,
  summarizeIntegrityReport,
  type IntegrityIssueSummary,
} from '@/lib/integrity/report';
import { getIntegrityIssueEntitiesAction, getIntegrityReportAction } from './actions';

type EventOption = { id: string; name: string; starts_at: string | null };

type IntegrityEntity = {
  entity_type: string;
  entity_id: string;
  event_id: string | null;
  title: string;
  description: string;
  action_label: string | null;
  action_href: string | null;
  metadata: unknown;
};

const SEVERITY_STYLES: Record<IntegrityIssueSummary['severity'], { badge: string; card: string; icon: string }> = {
  critical: { badge: 'bg-rose-500/20 text-rose-300 border-rose-500/40', card: 'border-rose-500/30 bg-rose-500/5', icon: '🔴' },
  attention: { badge: 'bg-amber-500/20 text-amber-300 border-amber-500/40', card: 'border-amber-500/30 bg-amber-500/5', icon: '🟠' },
  warning: { badge: 'bg-yellow-400/20 text-yellow-200 border-yellow-400/40', card: 'border-yellow-400/30 bg-yellow-400/5', icon: '🟡' },
};

const DOMAIN_ORDER = [
  'titularidade',
  'ingressos_pedidos',
  'categoria_preco',
  'camisetas_kits',
  'estoque',
  'checkin_retirada',
  'cadastros',
  'configuracao_evento',
];

type Props = {
  initialIssues: IntegrityIssueSummary[];
  totalDetectorCount: number;
  initialError: string | null;
  events: EventOption[];
};

export function IntegrityCenter({ initialIssues, totalDetectorCount, initialError, events }: Props) {
  const [issues, setIssues] = useState(initialIssues);
  const [error, setError] = useState(initialError);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const [drawerIssue, setDrawerIssue] = useState<IntegrityIssueSummary | null>(null);
  const [entities, setEntities] = useState<IntegrityEntity[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entitiesError, setEntitiesError] = useState<string | null>(null);

  const totals = useMemo(() => summarizeIntegrityReport(issues, totalDetectorCount), [issues, totalDetectorCount]);

  const grouped = useMemo(() => {
    const byDomain = new Map<string, IntegrityIssueSummary[]>();
    for (const issue of issues) {
      const list = byDomain.get(issue.domain) ?? [];
      list.push(issue);
      byDomain.set(issue.domain, list);
    }
    const domains = Array.from(byDomain.keys()).sort((a, b) => {
      const ai = DOMAIN_ORDER.indexOf(a);
      const bi = DOMAIN_ORDER.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    return domains.map((domain) => ({ domain, issues: byDomain.get(domain)! }));
  }, [issues]);

  function handleEventChange(eventId: string) {
    const next = eventId === '' ? null : eventId;
    setSelectedEventId(next);
    startTransition(async () => {
      const result = await getIntegrityReportAction(next);
      if (result.success) {
        setIssues(result.issues);
        setError(null);
      } else {
        setError(result.message);
      }
    });
  }

  function openDrawer(issue: IntegrityIssueSummary) {
    setDrawerIssue(issue);
    setEntities([]);
    setEntitiesError(null);
    setEntitiesLoading(true);
    getIntegrityIssueEntitiesAction(issue.code, selectedEventId).then((result) => {
      setEntitiesLoading(false);
      if (result.success) {
        setEntities(result.entities as IntegrityEntity[]);
      } else {
        setEntitiesError(result.message);
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-sm text-slate-300">
          Evento
          <select
            value={selectedEventId ?? ''}
            onChange={(event) => handleEventChange(event.target.value)}
            className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">Todos os eventos</option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>
                {event.name}
              </option>
            ))}
          </select>
        </label>
        {isPending && <span className="text-xs text-slate-500">Atualizando…</span>}
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard icon="🔴" label="Bloqueios" value={totals.critical} tone="rose" />
        <SummaryCard icon="🟠" label="Precisam de atenção" value={totals.attention} tone="amber" />
        <SummaryCard icon="🟡" label="Avisos" value={totals.warning} tone="yellow" />
        <SummaryCard icon="✅" label="Verificações aprovadas" value={totals.ok} tone="emerald" />
      </div>

      {issues.length === 0 && !error ? (
        <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-6 text-center text-sm text-emerald-200">
          ✓ Nenhum problema operacional detectado.
        </div>
      ) : (
        <div className="space-y-6">
          {grouped.map((group) => (
            <div key={group.domain}>
              <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-slate-400">
                {INTEGRITY_DOMAIN_LABELS[group.domain] ?? group.domain}
              </h3>
              <div className="space-y-2">
                {group.issues.map((issue) => (
                  <IssueCard key={`${issue.code}-${issue.eventId ?? 'all'}`} issue={issue} onOpen={() => openDrawer(issue)} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <SlideOverPanel open={drawerIssue !== null} title={drawerIssue?.title ?? ''} onClose={() => setDrawerIssue(null)}>
        {drawerIssue && (
          <div className="space-y-4">
            <p className="text-sm text-slate-300">{drawerIssue.description}</p>
            {entitiesLoading && <p className="text-sm text-slate-500">Carregando registros…</p>}
            {entitiesError && <p className="text-sm text-rose-300">{entitiesError}</p>}
            <div className="space-y-2">
              {entities.map((entity) => (
                <div key={`${entity.entity_type}-${entity.entity_id}`} className="rounded-xl border border-slate-700 bg-slate-900/60 p-3">
                  <p className="text-sm font-medium text-slate-100">{entity.title}</p>
                  <p className="mt-1 text-xs text-slate-400">{entity.description}</p>
                  {entity.action_href && entity.action_label && (
                    <Link href={entity.action_href} className="mt-2 inline-block text-xs font-semibold text-emerald-300 hover:underline">
                      {entity.action_label} →
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </SlideOverPanel>
    </div>
  );
}

function SummaryCard({ icon, label, value, tone }: { icon: string; label: string; value: number; tone: 'rose' | 'amber' | 'yellow' | 'emerald' }) {
  const toneClass = {
    rose: 'border-rose-500/30 bg-rose-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    yellow: 'border-yellow-400/30 bg-yellow-400/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
  }[tone];
  return (
    <div className={`rounded-2xl border p-4 ${toneClass}`}>
      <p className="text-2xl">{icon}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </div>
  );
}

function IssueCard({ issue, onOpen }: { issue: IntegrityIssueSummary; onOpen: () => void }) {
  const styles = SEVERITY_STYLES[issue.severity];
  return (
    <div className={`rounded-2xl border p-4 ${styles.card}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase ${styles.badge}`}>
              {styles.icon} {INTEGRITY_SEVERITY_LABELS[issue.severity]}
            </span>
          </div>
          <p className="mt-2 text-sm font-semibold text-slate-100">{issue.title}</p>
          <p className="mt-1 text-sm text-slate-400">{issue.description}</p>
          {issue.affectedCount > 1 && (
            <p className="mt-1 text-xs text-slate-500">{issue.affectedCount} registros afetados</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {issue.affectedCount > 1 ? (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Ver {issue.affectedCount} registros
            </button>
          ) : issue.actionHref && issue.actionLabel ? (
            <Link href={issue.actionHref} className="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800">
              {issue.actionLabel}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onOpen}
              className="rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Ver detalhes
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
