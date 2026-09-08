export function isLegacyCsvWithoutMediaId(input: {
  source: string;
  instagramMediaId?: string | null;
  instagramIntegrationId?: string | null;
}) {
  return input.source === "csv" && !input.instagramMediaId && !input.instagramIntegrationId;
}

export function assertGiveawaySourceIntegrity(input: {
  source: "csv" | "instagram";
  instagramIntegrationId: string | null;
  instagramMediaId: string | null;
  instagramMediaPermalink: string | null;
}) {
  if (input.source === "instagram") {
    if (!input.instagramIntegrationId || !input.instagramMediaId || !input.instagramMediaPermalink) {
      throw new Error("A origem Instagram esta incompleta.");
    }
    return;
  }
  if (input.instagramIntegrationId || input.instagramMediaId) {
    throw new Error("Um sorteio CSV nao pode referenciar uma publicacao do Instagram.");
  }
}
