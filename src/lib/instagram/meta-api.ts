import "server-only";
import { InstagramOAuthError } from "@/lib/instagram/oauth-errors";
import { readMetaError } from "@/lib/instagram/meta-error";
import { isInstagramRuntimeConfigured, requireInstagramRedirectUri } from "@/lib/instagram/oauth-config";
import { logInstagramRedirectUri } from "@/lib/instagram/oauth-log";
import { buildInstagramAuthorizationCodeForm } from "@/lib/instagram/oauth-token-form";

const apiVersion = process.env.META_GRAPH_API_VERSION?.trim();
const graphBase = "https://graph.instagram.com";

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

type MetaPage<T> = { data?: T[]; paging?: { next?: string }; error?: { message?: string } };

type MetaErrorBody = { error?: { code?: number; error_subcode?: number; type?: string; message?: string } };

function safeMetaError(status: number, body: MetaErrorBody) {
  const code = body.error?.code;
  if (code === 190) return new Error("A conexao com o Instagram expirou. Conecte a conta novamente.");
  if (code === 10 || code === 200) return new Error("O app nao possui permissao suficiente para esta operacao no Instagram.");
  if (code === 4 || code === 17 || code === 32 || code === 613 || status === 429) return new Error("O limite temporario de chamadas da Meta foi atingido. Tente novamente mais tarde.");
  if (code === 100 || status === 404) return new Error("A publicacao nao foi encontrada ou nao esta acessivel pela conta conectada.");
  return new Error("A Meta nao conseguiu concluir a operacao. Tente novamente ou reconecte a conta.");
}

async function metaJson<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  assertGraphInstagramUrl(url);
  const response = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  const body = await response.json() as T & MetaErrorBody;
  if (!response.ok || body.error) throw safeMetaError(response.status, body);
  return body;
}

export type InstagramMedia = { id: string; caption?: string; media_type?: string; media_url?: string; permalink?: string; timestamp?: string; thumbnail_url?: string };
export type InstagramComment = { id: string; text?: string; timestamp?: string; username?: string; from?: { id?: string; username?: string } };

async function allPages<T>(firstUrl: string, accessToken: string): Promise<T[]> {
  const values: T[] = [];
  let next: string | undefined = firstUrl;
  let pages = 0;
  while (next) {
    if (++pages > 10_000) throw new Error("Paginacao da Meta excedeu o limite de seguranca.");
    const page: MetaPage<T> = await metaJson(next, accessToken);
    values.push(...(page.data ?? []));
    next = page.paging?.next;
  }
  return values;
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
  const response = await fetch(url, { cache: "no-store" });
  const body = await response.json() as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!response.ok || !body.access_token) throw safeMetaError(response.status, body);
  return { accessToken: body.access_token, expiresIn: body.expires_in ?? null };
}

export async function listInstagramMedia(userId: string, accessToken: string) {
  return allPages<InstagramMedia>(versioned(`${userId}/media?fields=id,caption,media_type,permalink,timestamp,thumbnail_url&limit=100`), accessToken);
}

export async function listInstagramComments(mediaId: string, accessToken: string) {
  return allPages<InstagramComment>(versioned(`${mediaId}/comments?fields=from,text,timestamp&limit=100`), accessToken);
}
