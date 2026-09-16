import "server-only";
import { InstagramOAuthError } from "@/lib/instagram/oauth-errors";
import {
  classifyInstagramGraphFailure,
  instagramMediaLoadUserCopy,
  logInstagramGraphEvent,
  readMetaError,
  type InstagramGraphFailureKind,
} from "@/lib/instagram/meta-error";
import { isInstagramRuntimeConfigured, requireInstagramRedirectUri } from "@/lib/instagram/oauth-config";
import { instagramRedirectUriDiagnostics, logInstagramAppSecretInspect, logInstagramOAuthTokenRequest, logInstagramRedirectUri } from "@/lib/instagram/oauth-log";
import { buildInstagramAuthorizationCodeForm } from "@/lib/instagram/oauth-token-form";
import { inspectInstagramAppSecret, sha256Hex } from "@/lib/instagram/oauth-code-inspect";
import { INSTAGRAM_COMMENTS_FIELDS, INSTAGRAM_COMMENTS_PAGE_LIMIT, logicalGraphEndpoint, walkInstagramPages } from "@/lib/instagram/graph-pagination";

const apiVersion = process.env.META_GRAPH_API_VERSION?.trim();
const graphBase = "https://graph.instagram.com";
export const INSTAGRAM_GRAPH_TIMEOUT_MS = 15_000;
export const INSTAGRAM_MEDIA_FIELDS = "id,caption,media_type,permalink,timestamp,thumbnail_url,media_url";
export const INSTAGRAM_MEDIA_FIELDS_WITHOUT_URL = "id,caption,media_type,permalink,timestamp,thumbnail_url";

function versioned(path: string) {
  if (!apiVersion) throw new Error("META_GRAPH_API_VERSION nao configurada. Defina explicitamente a versao vigente da Graph API.");
  return `${graphBase}/${apiVersion}/${path.replace(/^\//, "")}`;
}

function assertGraphInstagramUrl(value: string) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.hostname !== "graph.instagram.com") {
    throw new Error("A Meta retornou uma URL de paginacao invalida.");
  }
}

type MetaPage<T> = {
  data?: T[];
  paging?: { next?: string; cursors?: { after?: string } };
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
};

type MetaErrorBody = { error?: { code?: number; error_subcode?: number; type?: string; message?: string; fbtrace_id?: string } };

export type GraphFetchFail = {
  ok: false;
  kind: InstagramGraphFailureKind;
  status: number;
  errorCode?: number | string;
  errorSubcode?: number | string;
  errorType?: string;
  fbtraceId?: string;
  sanitizedMessage: string;
  durationMs: number;
};

async function readGraphBody(response: Response): Promise<{ body: unknown; jsonParseFailed: boolean }> {
  const text = await response.text();
  if (!text.trim()) return { body: {}, jsonParseFailed: false };
  try {
    return { body: JSON.parse(text) as unknown, jsonParseFailed: false };
  } catch {
    return { body: { error: { message: "resposta_nao_json", type: "ParseException" } }, jsonParseFailed: true };
  }
}

type GraphFetchOk<T> = { ok: true; status: number; body: T; durationMs: number };

function failFromDetails(
  kind: InstagramGraphFailureKind,
  details: ReturnType<typeof readMetaError>,
  durationMs: number,
  extras?: { jsonParseFailed?: boolean; operation?: string; endpoint?: string },
): GraphFetchFail {
  logInstagramGraphEvent({
    event: kind === "timeout" ? "graph_timeout" : kind === "network" ? "graph_network_error" : "graph_error",
    operation: extras?.operation ?? null,
    endpoint: extras?.endpoint ?? null,
    graphVersion: apiVersion ?? null,
    httpStatus: details.httpStatus,
    errorCode: details.errorCode ?? null,
    errorSubcode: details.errorSubcode ?? null,
    errorType: details.errorType ?? null,
    fbtraceId: details.fbtraceId ?? null,
    sanitizedMessage: details.sanitizedMessage,
    jsonParseFailed: extras?.jsonParseFailed ?? false,
    kind,
    durationMs,
  });
  return {
    ok: false,
    kind,
    status: details.httpStatus,
    errorCode: details.errorCode,
    errorSubcode: details.errorSubcode,
    errorType: details.errorType,
    fbtraceId: details.fbtraceId,
    sanitizedMessage: details.sanitizedMessage,
    durationMs,
  };
}

async function fetchGraph<T>(
  url: string,
  accessToken: string,
  options?: { init?: RequestInit; operation?: string },
): Promise<GraphFetchOk<T> | GraphFetchFail> {
  assertGraphInstagramUrl(url);
  const endpoint = logicalGraphEndpoint(url);
  const operation = options?.operation;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTAGRAM_GRAPH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options?.init,
      signal: options?.init?.signal ?? controller.signal,
      headers: { ...options?.init?.headers, Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    const durationMs = Date.now() - started;
    const { body, jsonParseFailed } = await readGraphBody(response);
    const details = readMetaError(response.status, body);
    const record = body && typeof body === "object" ? (body as MetaErrorBody) : {};
    if (jsonParseFailed || !response.ok || record.error) {
      const kind = classifyInstagramGraphFailure({
        httpStatus: response.status,
        errorCode: details.errorCode,
        errorSubcode: details.errorSubcode,
        jsonParseFailed,
      });
      return failFromDetails(kind, { ...details, httpStatus: response.status }, durationMs, {
        jsonParseFailed,
        operation,
        endpoint,
      });
    }
    return { ok: true, status: response.status, body: body as T, durationMs };
  } catch (error) {
    const durationMs = Date.now() - started;
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    const kind = classifyInstagramGraphFailure({ httpStatus: 0, timedOut, networkError: !timedOut });
    return failFromDetails(kind, {
      httpStatus: 0,
      sanitizedMessage: timedOut ? "timeout" : "network_error",
    }, durationMs, { operation, endpoint });
  } finally {
    clearTimeout(timer);
  }
}

function graphFailFields(result: GraphFetchFail): InstagramGraphCallFailure {
  return {
    ok: false,
    kind: result.kind,
    httpStatus: result.status,
    errorCode: result.errorCode,
    errorSubcode: result.errorSubcode,
    errorType: result.errorType,
    fbtraceId: result.fbtraceId,
    sanitizedMessage: result.sanitizedMessage,
    durationMs: result.durationMs,
  };
}

export type InstagramMedia = { id: string; caption?: string; media_type?: string; media_url?: string; permalink?: string; timestamp?: string; thumbnail_url?: string };
export type InstagramComment = { id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string } };

function nextUrlFromPage<T>(page: MetaPage<T>): { ok: true; next: string | undefined } | { ok: false; kind: InstagramGraphFailureKind; sanitizedMessage: string } {
  const raw = page.paging?.next;
  if (!raw) return { ok: true, next: undefined };
  try {
    assertGraphInstagramUrl(raw);
    return { ok: true, next: raw };
  } catch {
    return { ok: false, kind: "invalid_response", sanitizedMessage: "url_paginacao_invalida" };
  }
}

async function fetchGraphPage<T>(url: string, accessToken: string, operation: string) {
  const result = await fetchGraph<MetaPage<T>>(url, accessToken, { operation });
  if (!result.ok) return { ok: false as const, error: result };
  const next = nextUrlFromPage(result.body);
  if (!next.ok) {
    const error: GraphFetchFail = {
      ok: false,
      kind: next.kind,
      status: result.status,
      sanitizedMessage: next.sanitizedMessage,
      durationMs: result.durationMs,
    };
    return { ok: false as const, error };
  }
  return { ok: true as const, data: result.body.data ?? [], next: next.next ?? null, durationMs: result.durationMs };
}

export function instagramAuthorizeUrl(state: string) {
  const clientId = process.env.META_INSTAGRAM_APP_ID;
  const redirectUri = requireInstagramRedirectUri();
  if (!clientId || !redirectUri) throw new Error("META_INSTAGRAM_APP_ID e META_INSTAGRAM_REDIRECT_URI sao obrigatorios.");
  logInstagramRedirectUri("oauth_authorize", redirectUri);
  const params = new URLSearchParams({
    enable_fb_login: "0", force_authentication: "1", client_id: clientId,
    redirect_uri: redirectUri, response_type: "code", state,
    scope: "instagram_business_basic,instagram_business_manage_comments",
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function exchangeInstagramCode(code: string) {
  if (!isInstagramRuntimeConfigured()) {
    throw new InstagramOAuthError("oauth_token_exchange_failed", "unknown", "Integracao Instagram nao configurada.");
  }
  const clientId = process.env.META_INSTAGRAM_APP_ID!;
  const clientSecret = process.env.META_INSTAGRAM_APP_SECRET!;
  const redirectUri = requireInstagramRedirectUri();
  logInstagramRedirectUri("oauth_token_exchange", redirectUri);
  const secretInspect = inspectInstagramAppSecret(clientSecret);
  logInstagramAppSecretInspect(secretInspect);
  const redirect = instagramRedirectUriDiagnostics(redirectUri);
  logInstagramOAuthTokenRequest({
    clientIdLast4: clientId.slice(-4),
    clientSecretLength: secretInspect.length,
    clientSecretHashPrefix: secretInspect.hashPrefix,
    redirectUriLength: redirect.redirect_uri_length,
    redirectUriHash: redirect.redirect_uri_hash,
    codeLength: code.length,
    codeHash: sha256Hex(code),
    grantType: "authorization_code",
  });
  const form = buildInstagramAuthorizationCodeForm({
    clientId,
    clientSecret,
    redirectUri,
    code,
  });
  const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form, cache: "no-store" });
  const short = await shortResponse.json() as { access_token?: string; user_id?: number; error_message?: string; error_type?: string; code?: number };
  if (!shortResponse.ok || !short.access_token || !short.user_id) {
    throw new InstagramOAuthError("oauth_token_exchange_failed", "token", "Falha na troca do codigo OAuth.", readMetaError(shortResponse.status, short));
  }
  const longUrl = new URL(`${graphBase}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", clientSecret);
  longUrl.searchParams.set("access_token", short.access_token);
  const longResponse = await fetch(longUrl, { cache: "no-store" });
  const long = await longResponse.json() as { access_token?: string; expires_in?: number; error?: { message?: string; type?: string; code?: number } };
  if (!longResponse.ok || !long.access_token) {
    throw new InstagramOAuthError("oauth_token_exchange_failed", "token", "Falha na troca do codigo OAuth.", readMetaError(longResponse.status, long));
  }
  const meUrl = versioned("me?fields=user_id,username");
  assertGraphInstagramUrl(meUrl);
  const meResponse = await fetch(meUrl, {
    headers: { Authorization: `Bearer ${long.access_token}` },
    cache: "no-store",
  });
  const profile = await meResponse.json() as { id?: string; user_id?: string; username?: string; error?: { message?: string; type?: string; code?: number } };
  if (!meResponse.ok || profile.error || !profile.username) {
    throw new InstagramOAuthError("oauth_profile_fetch_failed", "profile", "Falha ao obter o perfil do Instagram.", readMetaError(meResponse.status, profile));
  }
  return { accessToken: long.access_token, expiresIn: long.expires_in ?? null, profile: { id: String(profile.user_id ?? profile.id ?? short.user_id), username: profile.username } };
}

export async function refreshInstagramAccessToken(accessToken: string) {
  const url = new URL(`${graphBase}/refresh_access_token`);
  url.searchParams.set("grant_type", "ig_refresh_token");
  url.searchParams.set("access_token", accessToken);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INSTAGRAM_GRAPH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    const { body, jsonParseFailed } = await readGraphBody(response);
    const details = readMetaError(response.status, body);
    const record = body && typeof body === "object" ? body as { access_token?: string; expires_in?: number; error?: unknown } : {};
    if (jsonParseFailed || !response.ok || record.error || !record.access_token) {
      const kind = classifyInstagramGraphFailure({
        httpStatus: response.status,
        errorCode: details.errorCode,
        errorSubcode: details.errorSubcode,
        jsonParseFailed,
      });
      logInstagramGraphEvent({
        event: "token_refresh_error",
        operation: "token_refresh",
        endpoint: "refresh_access_token",
        graphVersion: apiVersion ?? null,
        httpStatus: response.status,
        errorCode: details.errorCode ?? null,
        errorSubcode: details.errorSubcode ?? null,
        errorType: details.errorType ?? null,
        fbtraceId: details.fbtraceId ?? null,
        sanitizedMessage: details.sanitizedMessage,
        kind,
      });
      throw new Error(instagramMediaLoadUserCopy(kind).message);
    }
    return { accessToken: record.access_token, expiresIn: record.expires_in ?? null };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Não foi possível")) throw error;
    const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    logInstagramGraphEvent({
      event: timedOut ? "token_refresh_timeout" : "token_refresh_network_error",
      operation: "token_refresh",
      endpoint: "refresh_access_token",
      graphVersion: apiVersion ?? null,
      kind: timedOut ? "timeout" : "network",
    });
    throw new Error(instagramMediaLoadUserCopy(timedOut ? "timeout" : "network").message);
  } finally {
    clearTimeout(timer);
  }
}

export type InstagramGraphCallFailure = {
  ok: false;
  kind: InstagramGraphFailureKind;
  httpStatus: number;
  errorCode?: number | string;
  errorSubcode?: number | string;
  errorType?: string;
  fbtraceId?: string;
  sanitizedMessage: string;
  durationMs?: number;
  pagesFetched?: number;
  itemsFetched?: number;
};

export type InstagramMediaPageResult =
  | { ok: true; items: InstagramMedia[]; nextCursor: string | null }
  | InstagramGraphCallFailure;

export type InstagramMediaGetResult =
  | { ok: true; media: InstagramMedia }
  | InstagramGraphCallFailure;

export type InstagramCommentsResult =
  | { ok: true; items: InstagramComment[]; pagesFetched: number }
  | InstagramGraphCallFailure;

function mediaPageUrl(objectId: string, fields: string, after?: string | null) {
  const url = new URL(versioned(`${objectId}/media`));
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "24");
  if (after) url.searchParams.set("after", after);
  return url.toString();
}

function nextCursorFromPage(page: MetaPage<InstagramMedia>) {
  let nextCursor = page.paging?.cursors?.after ?? null;
  if (!nextCursor && page.paging?.next) {
    try {
      nextCursor = new URL(page.paging.next).searchParams.get("after");
    } catch {
      nextCursor = null;
    }
  }
  return nextCursor || null;
}

function shouldRetryWithoutMediaUrl(result: GraphFetchFail) {
  const code = Number(result.errorCode);
  return code === 100 || result.kind === "media_not_found" || result.kind === "invalid_response" || result.kind === "unknown";
}

function shouldFallbackToStoredUser(result: GraphFetchFail) {
  return result.kind === "media_not_found" || result.kind === "invalid_response" || result.kind === "unknown";
}

function shouldStopMediaAttempts(result: GraphFetchFail) {
  return result.kind === "expired_token" || result.kind === "permission" || result.kind === "rate_limit" || result.kind === "timeout" || result.kind === "network";
}

export async function listInstagramMedia(_userId: string, accessToken: string) {
  const walked = await walkInstagramPages<InstagramMedia, GraphFetchFail>(
    versioned(`me/media?fields=${INSTAGRAM_MEDIA_FIELDS}&limit=100`),
    (url) => fetchGraphPage<InstagramMedia>(url, accessToken, "media_list"),
  );
  if (!walked.ok) throw new Error(instagramMediaLoadUserCopy(walked.capExceeded ? "unknown" : walked.error.kind).message);
  return walked.items;
}

export async function listInstagramMediaPage(
  accessToken: string,
  after?: string | null,
  options?: { igUserId?: string | null },
): Promise<InstagramMediaPageResult> {
  const attempts: Array<{ objectId: "me" | "stored"; id: string; fields: string }> = [
    { objectId: "me", id: "me", fields: INSTAGRAM_MEDIA_FIELDS },
    { objectId: "me", id: "me", fields: INSTAGRAM_MEDIA_FIELDS_WITHOUT_URL },
  ];
  const storedId = String(options?.igUserId ?? "").trim();
  if (storedId && storedId !== "me") {
    attempts.push({ objectId: "stored", id: storedId, fields: INSTAGRAM_MEDIA_FIELDS });
    attempts.push({ objectId: "stored", id: storedId, fields: INSTAGRAM_MEDIA_FIELDS_WITHOUT_URL });
  }

  let lastFail: GraphFetchFail | null = null;
  for (const attempt of attempts) {
    if (attempt.objectId === "stored" && lastFail && !shouldFallbackToStoredUser(lastFail)) {
      continue;
    }
    if (attempt.fields === INSTAGRAM_MEDIA_FIELDS_WITHOUT_URL && lastFail && !shouldRetryWithoutMediaUrl(lastFail)) {
      continue;
    }
    const result = await fetchGraph<MetaPage<InstagramMedia>>(
      mediaPageUrl(attempt.id, attempt.fields, after),
      accessToken,
      { operation: "media_page" },
    );
    if (result.ok) {
      const items = result.body.data ?? [];
      logInstagramGraphEvent({
        event: "media_page_ok",
        operation: "media_page",
        endpoint: attempt.objectId === "me" ? "me/media" : "user/media",
        graphVersion: apiVersion ?? null,
        httpStatus: result.status,
        itemsFetched: items.length,
        pagesFetched: 1,
        durationMs: result.durationMs,
        usedObjectId: attempt.objectId === "me" ? "me" : "stored",
        omittedMediaUrl: attempt.fields === INSTAGRAM_MEDIA_FIELDS_WITHOUT_URL,
      });
      return { ok: true, items, nextCursor: nextCursorFromPage(result.body) };
    }
    lastFail = result;
    if (shouldStopMediaAttempts(result)) break;
  }

  return {
    ok: false,
    kind: lastFail?.kind ?? "unknown",
    httpStatus: lastFail?.status ?? 0,
    errorCode: lastFail?.errorCode,
    errorSubcode: lastFail?.errorSubcode,
    errorType: lastFail?.errorType,
    fbtraceId: lastFail?.fbtraceId,
    sanitizedMessage: lastFail?.sanitizedMessage ?? "operacao_meta_falhou",
    durationMs: lastFail?.durationMs,
  };
}

export async function getInstagramMedia(mediaId: string, accessToken: string): Promise<InstagramMediaGetResult> {
  const result = await fetchGraph<InstagramMedia>(versioned(`${mediaId}?fields=${INSTAGRAM_MEDIA_FIELDS}`), accessToken, { operation: "media_get" });
  if (!result.ok) return graphFailFields(result);
  return { ok: true, media: result.body };
}

export async function listInstagramComments(mediaId: string, accessToken: string): Promise<InstagramCommentsResult> {
  const started = Date.now();
  const walked = await walkInstagramPages<InstagramComment, GraphFetchFail>(
    versioned(`${mediaId}/comments?fields=${INSTAGRAM_COMMENTS_FIELDS}&limit=${INSTAGRAM_COMMENTS_PAGE_LIMIT}`),
    (url) => fetchGraphPage<InstagramComment>(url, accessToken, "comments"),
  );
  const durationMs = Date.now() - started;
  if (!walked.ok) {
    const fail = walked.capExceeded
      ? {
          ok: false as const,
          kind: "unknown" as const,
          status: 0,
          sanitizedMessage: "paginacao_excedeu_teto",
          durationMs,
        }
      : walked.error;
    logInstagramGraphEvent({
      event: "comments_failed",
      operation: "comments",
      endpoint: "comments",
      graphVersion: apiVersion ?? null,
      kind: fail.kind,
      httpStatus: fail.status,
      errorCode: fail.errorCode ?? null,
      errorSubcode: fail.errorSubcode ?? null,
      fbtraceId: fail.fbtraceId ?? null,
      pagesFetched: walked.pagesFetched,
      itemsFetched: walked.items.length,
      durationMs,
      capExceeded: walked.capExceeded ?? false,
    });
    return {
      ...graphFailFields(fail),
      pagesFetched: walked.pagesFetched,
      itemsFetched: walked.items.length,
    };
  }
  logInstagramGraphEvent({
    event: "comments_ok",
    operation: "comments",
    endpoint: "comments",
    graphVersion: apiVersion ?? null,
    httpStatus: 200,
    pagesFetched: walked.pagesFetched,
    itemsFetched: walked.items.length,
    durationMs,
    stoppedOnRepeatedCursor: walked.stoppedOnRepeatedCursor,
  });
  return { ok: true, items: walked.items, pagesFetched: walked.pagesFetched };
}
