export type InstagramMediaCard = {
  mediaId: string;
  mediaType: string;
  permalink: string;
  caption: string;
  timestamp: string;
  thumbnailUrl: string;
};

export function toInstagramMediaCard(item: {
  id: string;
  media_type?: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  thumbnail_url?: string;
  media_url?: string;
}): InstagramMediaCard {
  return {
    mediaId: item.id,
    mediaType: item.media_type ?? "",
    permalink: item.permalink ?? "",
    caption: item.caption ?? "",
    timestamp: item.timestamp ?? "",
    thumbnailUrl: item.thumbnail_url || item.media_url || "",
  };
}

export function extractInstagramPagingCursor(nextUrl: string | undefined, after: string | undefined) {
  if (after) return after;
  if (!nextUrl) return null;
  try {
    return new URL(nextUrl).searchParams.get("after");
  } catch {
    return null;
  }
}

export function assertNumericInstagramMediaId(mediaId: string) {
  if (!/^\d+$/.test(mediaId)) throw new Error("ID de midia invalido.");
}
