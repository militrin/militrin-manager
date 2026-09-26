import { PAGE_SIZE } from "./constants.ts";

export type CursorLike = {
  occurredAt: string;
  id: string;
};

export function encodeHistoryCursor(item: CursorLike) {
  return Buffer.from(`${item.occurredAt}\n${item.id}`, "utf8").toString("base64url");
}

export function decodeHistoryCursor(cursor: string | null | undefined): CursorLike | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const newline = decoded.indexOf("\n");
    if (newline <= 0) return null;
    const occurredAt = decoded.slice(0, newline).trim();
    const id = decoded.slice(newline + 1).trim();
    if (!occurredAt || !id) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export function compareOccurredDesc(a: CursorLike, b: CursorLike) {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function isOlderThanCursor(item: CursorLike, cursor: CursorLike) {
  return compareOccurredDesc(item, cursor) > 0;
}

export function paginateByCursor<T extends CursorLike>(
  items: T[],
  cursor: string | null | undefined,
  pageSize: number = PAGE_SIZE,
) {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.min(Math.floor(pageSize), 100) : PAGE_SIZE;
  const sorted = [...items].sort(compareOccurredDesc);
  const decoded = decodeHistoryCursor(cursor);
  let start = 0;
  if (decoded) {
    start = sorted.findIndex((item) => isOlderThanCursor(item, decoded));
    if (start < 0) return { items: [] as T[], nextCursor: null as string | null };
  }
  const page = sorted.slice(start, start + size);
  const nextCursor = page.length === size ? encodeHistoryCursor(page[page.length - 1]!) : null;
  return { items: page, nextCursor };
}
