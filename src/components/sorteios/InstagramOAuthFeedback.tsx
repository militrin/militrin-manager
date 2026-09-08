import { resolveInstagramOAuthFeedback } from "@/lib/instagram/oauth-feedback";

export function InstagramOAuthFeedback({
  instagram,
  reason,
}: {
  instagram?: string;
  reason?: string;
}) {
  const feedback = resolveInstagramOAuthFeedback(instagram, reason);
  if (!feedback) return null;
  const tone = feedback.status === "connected"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-100"
    : "border-rose-500/30 bg-rose-500/10 text-rose-200";
  return (
    <p role="status" className={`rounded-2xl border px-4 py-3 text-sm ${tone}`}>
      {feedback.message}
    </p>
  );
}
