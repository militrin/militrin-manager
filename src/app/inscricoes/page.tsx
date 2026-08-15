import { redirect } from "next/navigation";

type Params = {
  eventId?: string;
  q?: string;
};

export default async function LegacyRegistrationsPage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const destination = new URLSearchParams();

  if (params.eventId) destination.set("eventId", params.eventId);
  if (params.q) destination.set("q", params.q);

  redirect(`/cadastros${destination.size ? `?${destination.toString()}` : ""}`);
}
