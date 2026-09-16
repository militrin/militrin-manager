export const INSTAGRAM_COMMENTS_PAGE_LIMIT = 50;
export const INSTAGRAM_COMMENTS_FIELDS = "id,from,text,username,timestamp";
export const META_PAGE_SAFETY_CAP = 10_000;

export type InstagramPageFetchOk<T> = {
  ok: true;
  data?: T[];
  next?: string | null;
};

export type InstagramPageFetchFail<E> = {
  ok: false;
  error: E;
};

export type WalkInstagramPagesResult<T, E> =
  | { ok: true; items: T[]; pagesFetched: number; stoppedOnRepeatedCursor: boolean }
  | { ok: false; error: E; items: T[]; pagesFetched: number; stoppedOnRepeatedCursor: boolean; capExceeded?: boolean };

export function instagramPaginationFingerprint(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.delete("access_token");
  parsed.searchParams.delete("accessToken");
  return [
    parsed.hostname,
    parsed.pathname,
    `after=${parsed.searchParams.get("after") ?? ""}`,
    `before=${parsed.searchParams.get("before") ?? ""}`,
  ].join("|");
}

export function createInstagramPaginationGuard() {
  const seen = new Set<string>();
  return {
    shouldStop(url: string) {
      const fingerprint = instagramPaginationFingerprint(url);
      if (seen.has(fingerprint)) return true;
      seen.add(fingerprint);
      return false;
    },
  };
}

export function logicalGraphEndpoint(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    if (parsed.hostname === "graph.instagram.com" && path.endsWith("/refresh_access_token")) return "refresh_access_token";
    if (/\/me\/media$/.test(path)) return "me/media";
    if (/\/\d+\/media$/.test(path)) return "user/media";
    if (/\/comments$/.test(path)) return "comments";
    if (/\/me$/.test(path)) return "me";
    if (/\/\d+$/.test(path)) return "media";
    return "graph";
  } catch {
    return "invalid-url";
  }
}

export async function walkInstagramPages<T, E>(
  firstUrl: string,
  fetchPage: (url: string) => Promise<InstagramPageFetchOk<T> | InstagramPageFetchFail<E>>,
): Promise<WalkInstagramPagesResult<T, E>> {
  const values: T[] = [];
  const paginationGuard = createInstagramPaginationGuard();
  let next: string | undefined = firstUrl;
  let pages = 0;
  let stoppedOnRepeatedCursor = false;

  while (next) {
    if (paginationGuard.shouldStop(next)) {
      stoppedOnRepeatedCursor = true;
      break;
    }
    if (++pages > META_PAGE_SAFETY_CAP) {
      return {
        ok: false,
        error: { kind: "unknown" } as E,
        items: values,
        pagesFetched: pages,
        stoppedOnRepeatedCursor,
        capExceeded: true,
      };
    }
    const page = await fetchPage(next);
    if (!page.ok) {
      return {
        ok: false,
        error: page.error,
        items: values,
        pagesFetched: pages,
        stoppedOnRepeatedCursor,
      };
    }
    values.push(...(page.data ?? []));
    next = page.next || undefined;
  }

  return { ok: true, items: values, pagesFetched: pages, stoppedOnRepeatedCursor };
}
