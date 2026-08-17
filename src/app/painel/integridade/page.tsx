import { requirePermission } from '@/lib/admin/permissions';
import { MilitrinSection } from '@/components/militrin';
import { getIntegrityReportAction, listIntegrityEventsAction } from './actions';
import { IntegrityCenter } from './integrity-center';

export default async function IntegridadePage() {
  await requirePermission('integrity.view');

  const [reportResult, eventsResult] = await Promise.all([
    getIntegrityReportAction(null),
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
      />
    </MilitrinSection>
  );
}
