import { requirePermission } from '@/lib/admin/permissions';
import { MilitrinSection } from '@/components/militrin';
import { FeedbackManager } from './feedback-manager';
import { listFeedbackForAdminAction } from './actions';

export default async function FeedbacksPage({
  searchParams,
}: {
  searchParams: Promise<{ feedbackId?: string }>;
}) {
  await requirePermission('feedback.view');
  const { feedbackId } = await searchParams;

  const initial = await listFeedbackForAdminAction({ status: null, type: null, from: null, to: null });

  return (
    <MilitrinSection
      eyebrow="Suporte"
      title="Feedbacks"
      description="Problemas, sugestões e dúvidas reportados pelos usuários durante a fase beta."
    >
      <FeedbackManager
        initialFeedback={initial.success ? initial.feedback : []}
        initialFeedbackId={feedbackId ?? null}
      />
    </MilitrinSection>
  );
}
