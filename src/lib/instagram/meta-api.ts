import "server-only";

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
  const redirectUri = process.env.META_INSTAGRAM_REDIRECT_URI;
  if (!clientId || !redirectUri) throw new Error("META_INSTAGRAM_APP_ID e META_INSTAGRAM_REDIRECT_URI sao obrigatorios.");
  const params = new URLSearchParams({
    enable_fb_login: "0", force_authentication: "1", client_id: clientId,
    redirect_uri: redirectUri, response_type: "code", state,
    scope: "instagram_business_basic,instagram_business_manage_comments",
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

export async function exchangeInstagramCode(code: string) {
  const clientId = process.env.META_INSTAGRAM_APP_ID;
  const clientSecret = process.env.META_INSTAGRAM_APP_SECRET;
  const redirectUri = process.env.META_INSTAGRAM_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Credenciais Meta incompletas.");
  const form = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code });
  const shortResponse = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form, cache: "no-store" });
  const short = await shortResponse.json() as { access_token?: string; user_id?: number; error_message?: string };
  if (!shortResponse.ok || !short.access_token || !short.user_id) throw new Error("Nao foi possivel autorizar a conta do Instagram. Confira a configuracao do app e tente novamente.");
  const longUrl = new URL(`${graphBase}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", clientSecret);
  longUrl.searchParams.set("access_token", short.access_token);
  const long = await fetch(longUrl, { cache: "no-store" }).then((r) => r.json()) as { access_token?: string; expires_in?: number; error?: { message?: string } };
  if (!long.access_token) throw safeMetaError(400, long);
  const profile = await metaJson<{ id?: string; user_id?: string; username: string }>(versioned("me?fields=user_id,username"), long.access_token);
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
