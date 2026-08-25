'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { SlideOverPanel } from '@/components/admin/SlideOverPanel';
import {
  INTEGRITY_DOMAIN_LABELS,
  INTEGRITY_SEVERITY_LABELS,
  type IntegrityIssueSummary,
  type IntegritySeverity,
  summarizeIntegrityReport,
} from '@/lib/integrity/report';
import { describeAffected, type IntegrityDetectorCheck } from '@/lib/integrity/checks';
import { EntityCard, type IntegrityEntity } from './entity-card';
import { getIntegrityIssueEntitiesAction, getIntegrityReportAction } from './actions';

type EventOption = { id: string; name: string; starts_at: string | null };

const SEVERITY_ORDER: Record<IntegritySeverity, number> = { critical: 0, attention: 1, warning: 2 };

const SEVERITY_STYLES: Record<IntegritySeverity, { badge: string; card: string; icon: string }> = {
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

function sortDomains(domains: string[]) {
  return [...domains].sort((a, b) => {
    const ai = DOMAIN_ORDER.indexOf(a);
    const bi = DOMAIN_ORDER.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
}

// Uma linha por (code, event_id) vem da RPC agregadora -- quando "Todos os
// eventos" esta selecionado, o mesmo detector aparece 1x por evento afetado.
// Sem isso, a lista mostrava N cards identicos e sem contexto (mesmo titulo,
// mesma descricao). Consolida por code dentro do dominio: severidade = a
// mais alta entre as linhas, contagem somada, detalhe por evento na propria
// linha. O drawer continua buscando por code com o event_id global
// selecionado (null em "Todos os eventos") -- comportamento inalterado.
type ConsolidatedIssue = {
  code: string;
  severity: IntegritySeverity;
  domain: string;
  title: string;
  description: string;
  totalAffected: number;
  sampleEntityType: string | null;
  actionLabel: string | null;
  actionHref: string | null;
  perEvent: { eventId: string; eventName: string; count: number }[];
};

function consolidateByCode(issues: IntegrityIssueSummary[], eventNameById: Map<string, string>): ConsolidatedIssue[] {
  const byCode = new Map<string, IntegrityIssueSummary[]>();
  for (const issue of issues) {
    const list = byCode.get(issue.code) ?? [];
    list.push(issue);
    byCode.set(issue.code, list);
  }
  const consolidated = Array.from(byCode.values()).map((rows) => {
    const first = rows[0];
    const worst = rows.reduce((a, b) => (SEVERITY_ORDER[a.severity] <= SEVERITY_ORDER[b.severity] ? a : b));
    const totalAffected = rows.reduce((sum, row) => sum + row.affectedCount, 0);
    const perEvent = rows.length > 1
      ? rows.map((row) => ({
          eventId: row.eventId ?? '',
          eventName: row.eventId ? (eventNameById.get(row.eventId) ?? 'Evento') : 'Evento',
          count: row.affectedCount,
        }))
      : [];
    return {
      code: first.code,
      severity: worst.severity,
      domain: first.domain,
      title: first.title,
      description: first.description,
      totalAffected,
      sampleEntityType: first.sampleEntityType,
      actionLabel: rows.length === 1 ? first.actionLabel : null,
      actionHref: rows.length === 1 ? first.actionHref : null,
      perEvent,
    };
  });
  return consolidated.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
}

type Props = {
  initialIssues: IntegrityIssueSummary[];
  totalDetectorCount: number;
  checks: IntegrityDetectorCheck[];
  initialError: string | null;
  events: EventOption[];
  initialSelectedEventId: string | null;
};

export function IntegrityCenter({ initialIssues, totalDetectorCount, checks: initialChecks, initialError, events, initialSelectedEventId }: Props) {
  const router = useRouter();
  const [issues, setIssues] = useState(initialIssues);
  const [checks, setChecks] = useState(initialChecks);
  const [error, setError] = useState(initialError);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(initialSelectedEventId);
  const [isPending, startTransition] = useTransition();

  const [drawerIssue, setDrawerIssue] = useState<ConsolidatedIssue | null>(null);
  const [entities, setEntities] = useState<IntegrityEntity[]>([]);
  const [entitiesLoading, setEntitiesLoading] = useState(false);
  const [entitiesError, setEntitiesError] = useState<string | null>(null);
  const [checksDrawerOpen, setChecksDrawerOpen] = useState(false);

  const eventNameById = useMemo(() => new Map(events.map((event) => [event.id, event.name])), [events]);

  const totals = useMemo(() => summarizeIntegrityReport(issues, totalDetectorCount), [issues, totalDetectorCount]);

  const grouped = useMemo(() => {
    const byDomain = new Map<string, IntegrityIssueSummary[]>();
    for (const issue of issues) {
      const list = byDomain.get(issue.domain) ?? [];
      list.push(issue);
      byDomain.set(issue.domain, list);
    }
    return sortDomains(Array.from(byDomain.keys())).map((domain) => ({
      domain,
      cards: consolidateByCode(byDomain.get(domain)!, eventNameById),
    }));
  }, [issues, eventNameById]);

  const passedChecks = useMemo(() => {
    const codesWithIssues = new Set(issues.map((issue) => issue.code));
    const remaining = checks.filter((check) => !codesWithIssues.has(check.code));
    const byDomain = new Map<string, IntegrityDetectorCheck[]>();
    for (const check of remaining) {
      const list = byDomain.get(check.domain) ?? [];
      list.push(check);
      byDomain.set(check.domain, list);
    }
    return sortDomains(Array.from(byDomain.keys())).map((domain) => ({ domain, checks: byDomain.get(domain)! }));
  }, [issues, checks]);

  function fetchReport(eventId: string | null) {
    startTransition(async () => {
      const result = await getIntegrityReportAction(eventId);
      if (result.success) {
        setIssues(result.issues);
        setChecks(result.checks);
        setError(null);
      } else {
        setError(result.message);
      }
    });
  }

  function handleEventChange(eventId: string) {
    const next = eventId === '' ? null : eventId;
    setSelectedEventId(next);
    router.replace(next ? `/painel/integridade?eventId=${encodeURIComponent(next)}` : '/painel/integridade', { scroll: false });
    fetchReport(next);
  }

  function openDrawer(issue: ConsolidatedIssue) {
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
        <div className="flex items-center gap-3">
          {isPending && <span className="text-xs text-slate-500">Atualizando…</span>}
          <button
            type="button"
            onClick={() => fetchReport(selectedEventId)}
            disabled={isPending}
            className="min-h-10 rounded-xl border border-slate-600 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          >
            Atualizar
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{error}</div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SummaryCard icon="🔴" label="Bloqueios" value={totals.critical} tone="rose" />
        <SummaryCard icon="🟠" label="Precisam de atenção" value={totals.attention} tone="amber" />
        <SummaryCard icon="🟡" label="Avisos" value={totals.warning} tone="yellow" />
        <SummaryCard icon="✅" label="Verificações aprovadas" value={totals.ok} tone="emerald" onClick={() => setChecksDrawerOpen(true)} />
      </div>

      <div className={`rounded-2xl border p-4 ${totals.critical ? 'border-rose-500/30 bg-rose-500/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
        <h2 className={`font-semibold ${totals.critical ? 'text-rose-200' : 'text-emerald-200'}`}>Bloqueios ({totals.critical})</h2>
        {!totals.critical ? <p className="mt-1 text-sm text-emerald-200">Nenhum bloqueio encontrado.</p> : <p className="mt-1 text-sm text-rose-200">Os bloqueios estão listados abaixo com a entidade afetada e a ação recomendada.</p>}
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
                {group.cards.map((issue) => (
                  <IssueCard key={issue.code} issue={issue} onOpen={() => openDrawer(issue)} />
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
                <EntityCard key={`${entity.entity_type}-${entity.entity_id}`} code={drawerIssue.code} entity={entity} />
              ))}
            </div>
          </div>
        )}
      </SlideOverPanel>

      <SlideOverPanel open={checksDrawerOpen} title="Verificações aprovadas" onClose={() => setChecksDrawerOpen(false)}>
        <div className="space-y-5">
          {passedChecks.length === 0 && <p className="text-sm text-slate-400">Nenhuma verificação aprovada no momento.</p>}
          {passedChecks.map((group) => (
            <div key={group.domain}>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                {INTEGRITY_DOMAIN_LABELS[group.domain] ?? group.domain}
              </h4>
              <div className="space-y-2">
                {group.checks.map((check) => (
                  <div key={check.code} className="flex items-start gap-2 rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                    <span className="text-emerald-300">✓</span>
                    <p className="text-sm text-slate-200">{check.label}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </SlideOverPanel>
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  tone,
  onClick,
}: {
  icon: string;
  label: string;
  value: number;
  tone: 'rose' | 'amber' | 'yellow' | 'emerald';
  onClick?: () => void;
}) {
  const toneClass = {
    rose: 'border-rose-500/30 bg-rose-500/5',
    amber: 'border-amber-500/30 bg-amber-500/5',
    yellow: 'border-yellow-400/30 bg-yellow-400/5',
    emerald: 'border-emerald-500/30 bg-emerald-500/5',
  }[tone];
  const content = (
    <>
      <p className="text-2xl">{icon}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      <p className="text-xs text-slate-400">{label}</p>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={`min-h-11 rounded-2xl border p-4 text-left transition hover:brightness-110 ${toneClass}`}
      >
        {content}
      </button>
    );
  }
  return <div className={`rounded-2xl border p-4 ${toneClass}`}>{content}</div>;
}

function IssueCard({ issue, onOpen }: { issue: ConsolidatedIssue; onOpen: () => void }) {
  const styles = SEVERITY_STYLES[issue.severity];
  const hasSingleAction = issue.perEvent.length === 0 && issue.totalAffected === 1 && issue.actionHref && issue.actionLabel;
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
          <p className="mt-1 text-xs text-slate-500">{describeAffected(issue.sampleEntityType, issue.totalAffected)}</p>
          {issue.perEvent.length > 0 && (
            <p className="mt-1 text-xs text-slate-500">
              Ocorre em {issue.perEvent.length} eventos: {issue.perEvent.map((row) => `${row.eventName} (${row.count})`).join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          {hasSingleAction ? (
            <Link
              href={issue.actionHref!}
              className="flex min-h-11 items-center rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              {issue.actionLabel}
            </Link>
          ) : (
            <button
              type="button"
              onClick={onOpen}
              className="flex min-h-11 items-center rounded-xl border border-slate-600 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Ver {issue.totalAffected} registro{issue.totalAffected === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
