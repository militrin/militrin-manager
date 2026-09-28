import { redirect } from "next/navigation";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function BatchesRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ eventId?: string }>;
}) {
  const { eventId } = await searchParams;
  if (eventId && uuid.test(eventId)) {
    redirect(`/painel/eventos/${eventId}?etapa=3`);
  }
  redirect("/painel/eventos");
}
