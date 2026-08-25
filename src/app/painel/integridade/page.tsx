import { requirePermission } from '@/lib/admin/permissions';
import { MilitrinSection } from '@/components/militrin';
import { getIntegrityReportAction, listIntegrityEventsAction } from './actions';
import { IntegrityCenter } from './integrity-center';

export default async function IntegridadePage({ searchParams }: { searchParams: Promise<{ eventId?: string }> }) {
  await requirePermission('integrity.view');
  const { eventId: rawEventId } = await searchParams;
  const eventId = rawEventId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawEventId) ? rawEventId : null;

  const [reportResult, eventsResult] = await Promise.all([
    getIntegrityReportAction(eventId),
    listIntegrityEventsAction(),
  ]);

  return (
    <MilitrinSection
      eyebrow="Administração"
      title="Integridade Operacional"
      description="Identifique e resolva inconsistências antes que elas afetem a operação do evento."
    >
      <IntegrityCenter
        initialIssues={reportResult.success ? reportResult.issues : []}
        totalDetectorCount={reportResult.success ? reportResult.totalDetectorCount : 0}
        checks={reportResult.success ? reportResult.checks : []}
        initialError={reportResult.success ? null : reportResult.message}
        events={eventsResult.success ? eventsResult.events : []}
        initialSelectedEventId={eventId}
      />
    </MilitrinSection>
  );
}
