import { hasPermission, requireAnyPermission } from '@/lib/admin/permissions';
import { MilitrinSection } from '@/components/militrin';
import { getIntegrityReportAction, listIntegrityEventsAction, listPaidOrdersAwaitingTicketIssueAction, listGatewayFinancialDivergencesAction } from './actions';
import { IntegrityCenter } from './integrity-center';
import { PaidOrdersAwaitingIssuePanel } from './paid-orders-awaiting-issue';
import { GatewayFinancialDivergencesPanel } from './gateway-financial-divergences-panel';

export default async function IntegridadePage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  await requireAnyPermission(['integrity.view', 'finance.confirm_payment']);
  const { eventId: rawEventId } = await searchParams;
  const eventId = rawEventId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawEventId) ? rawEventId : null;

  const [canViewReport, canIssue, queueResult, eventsResult, divergencesResult] = await Promise.all([
    hasPermission('integrity.view'),
    hasPermission('finance.confirm_payment'),
    listPaidOrdersAwaitingTicketIssueAction(),
    listIntegrityEventsAction(),
    listGatewayFinancialDivergencesAction(),
  ]);

  const reportResult = canViewReport
    ? await getIntegrityReportAction(eventId)
    : { success: true as const, issues: [], totalDetectorCount: 0, checks: [], message: undefined };

  return (
    <MilitrinSection
      eyebrow="Administração"
      title="Integridade Operacional"
      description="Identifique e resolva inconsistências antes que elas afetem a operação do evento."
    >
      <div className="space-y-6">
        <GatewayFinancialDivergencesPanel
          divergences={divergencesResult.success ? divergencesResult.divergences : []}
        />
        <PaidOrdersAwaitingIssuePanel
          orders={queueResult.success ? queueResult.orders : []}
          canIssue={canIssue}
          selectedEventId={eventId}
        />
        {queueResult.success ? null : (
          <p className="text-sm text-rose-300">{queueResult.message}</p>
        )}
        {canViewReport ? (
          <IntegrityCenter
            initialIssues={reportResult.success ? reportResult.issues : []}
            totalDetectorCount={reportResult.success ? reportResult.totalDetectorCount : 0}
            checks={reportResult.success ? reportResult.checks : []}
            initialError={!reportResult.success ? reportResult.message : null}
            events={eventsResult.success ? eventsResult.events : []}
            initialSelectedEventId={eventId}
          />
        ) : null}
      </div>
    </MilitrinSection>
  );
}
