export type OfficialInstagramComment = {
  id: string;
  text?: string;
  timestamp?: string;
  username?: string;
  from?: { id?: string; username?: string };
};

export type OfficialInstagramMedia = {
  id: string;
  permalink?: string;
  caption?: string;
  timestamp?: string;
  media_type?: string;
  media_url?: string;
  thumbnail_url?: string;
};

export function extractInstagramMentions(text: string) {
  return Array.from(text.matchAll(/(^|[^\w.])@([a-zA-Z0-9._]{1,30})/g), (match) => match[2]);
}

export function normalizeInstagramComment(comment: OfficialInstagramComment, entryNumber: number, permalink: string) {
  const author = comment.from?.username ?? comment.username;
  if (!author) throw new Error(`A Meta nao retornou o autor oficial do comentario ${comment.id}.`);
  const text = comment.text ?? "";
  const mentions = extractInstagramMentions(text);
  return {
    entryNumber,
    commentId: comment.id,
    username: author,
    comment: text,
    mentionsCount: mentions.length,
    mentions: mentions.map((name) => `@${name}`).join(" "),
    commentUrl: permalink,
    commentCreatedAt: comment.timestamp ?? null,
    chance: "1",
    status: "active" as const,
  };
}

export function normalizeUniqueInstagramComments(comments: OfficialInstagramComment[], permalink: string) {
  const seen = new Set<string>();
  return comments.flatMap((comment) => {
    if (seen.has(comment.id)) return [];
    seen.add(comment.id);
    return [normalizeInstagramComment(comment, seen.size, permalink)];
  });
}

export function resolveOwnedInstagramMedia(media: OfficialInstagramMedia[], mediaId: string) {
  const found = media.find((item) => item.id === mediaId);
  if (!found) throw new Error("A publicacao nao pertence a conta Instagram conectada.");
  if (!found.permalink) throw new Error("A Meta nao retornou o permalink oficial da publicacao.");
  const permalink = new URL(found.permalink);
  if (permalink.protocol !== "https:" || !/(^|\.)instagram\.com$/i.test(permalink.hostname)) throw new Error("A Meta retornou um permalink invalido para a publicacao.");
  return found;
}

export type FrozenSnapshotIdentity = {
  source: "csv" | "instagram";
  sourceFileName: string | null;
  instagramIntegrationId: string | null;
  instagramMediaId: string | null;
  instagramMediaPermalink: string | null;
  commentIds: string[];
};

export function assertFrozenSnapshotInvariant(persisted: FrozenSnapshotIdentity, incoming: FrozenSnapshotIdentity) {
  if (persisted.source !== incoming.source || persisted.sourceFileName !== incoming.sourceFileName ||
      persisted.instagramIntegrationId !== incoming.instagramIntegrationId || persisted.instagramMediaId !== incoming.instagramMediaId ||
      persisted.instagramMediaPermalink !== incoming.instagramMediaPermalink) {
    throw new Error("A origem ou publicacao de um snapshot congelado nao pode mudar.");
  }
  const persistedIds = new Set(persisted.commentIds);
  const incomingIds = new Set(incoming.commentIds);
  if (persistedIds.size !== persisted.commentIds.length || incomingIds.size !== incoming.commentIds.length ||
      persistedIds.size !== incomingIds.size || [...persistedIds].some((id) => !incomingIds.has(id))) {
    throw new Error("A lista de participacoes de um snapshot congelado nao pode mudar.");
  }
}

export function assertUniqueCommentIds(commentIds: string[]) {
  if (new Set(commentIds).size !== commentIds.length) throw new Error("Cada comment_id pode aparecer apenas uma vez no sorteio.");
}
