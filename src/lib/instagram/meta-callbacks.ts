import { randomBytes } from "node:crypto";
import { parseMetaSignedRequest, readSignedRequestFromUrlEncodedBody } from "./signed-request.ts";

export const INSTAGRAM_DATA_DELETION_STATUS_PATH = "/exclusao-de-dados/status";
export const INSTAGRAM_CONFIRMATION_CODE_PATTERN = /^[A-Za-z0-9_-]{32,86}$/;

export type InstagramDataDeletionPublicStatus = {
  status: "received" | "credentials_revoked";
  createdAt: string;
};

export type MetaCallbackStore = {
  deauthorize(instagramUserId: string): Promise<{ disconnectedNow: number; alreadyDisconnected: number }>;
  requestDataDeletion(instagramUserId: string, confirmationCode: string): Promise<{ confirmationCode: string; reused: boolean }>;
  getPublicStatus(confirmationCode: string): Promise<InstagramDataDeletionPublicStatus | null>;
};

export type MetaCallbackHttpResult = {
  status: number;
  body: Record<string, unknown> | null;
};

export function generateInstagramDeletionConfirmationCode() {
  return randomBytes(32).toString("base64url");
}

export function instagramDataDeletionStatusPath(confirmationCode: string) {
  return `${INSTAGRAM_DATA_DELETION_STATUS_PATH}/${encodeURIComponent(confirmationCode)}`;
}

export function instagramDataDeletionStatusUrl(confirmationCode: string, baseUrl = "https://www.militrin.com.br") {
  return `${baseUrl}${instagramDataDeletionStatusPath(confirmationCode)}`;
}

export function isValidInstagramConfirmationCode(value: string) {
  return INSTAGRAM_CONFIRMATION_CODE_PATTERN.test(value);
}

export async function processInstagramMetaCallbackPost(
  rawBody: string,
  contentType: string | null,
  input: {
    appSecret: string | undefined;
    store: MetaCallbackStore;
    kind: "deauthorize" | "data-deletion";
    baseUrl?: string;
  },
): Promise<MetaCallbackHttpResult> {
  if (!input.appSecret) {
    return { status: 503, body: { error: "Integracao Instagram nao configurada." } };
  }

  if (contentType && !contentType.includes("application/x-www-form-urlencoded")) {
    return { status: 400, body: { error: "Requisicao invalida." } };
  }

  const signedRequest = readSignedRequestFromUrlEncodedBody(rawBody);
  if (!signedRequest) {
    return { status: 400, body: { error: "Requisicao invalida." } };
  }

  const parsed = parseMetaSignedRequest(signedRequest, input.appSecret);
  if (!parsed.ok) {
    return { status: parsed.status, body: { error: "Requisicao invalida." } };
  }

  try {
    if (input.kind === "deauthorize") {
      await input.store.deauthorize(parsed.payload.user_id);
      return { status: 200, body: null };
    }

    const created = await input.store.requestDataDeletion(
      parsed.payload.user_id,
      generateInstagramDeletionConfirmationCode(),
    );
    return {
      status: 200,
      body: {
        url: instagramDataDeletionStatusUrl(created.confirmationCode, input.baseUrl),
        confirmation_code: created.confirmationCode,
      },
    };
  } catch {
    return { status: 500, body: { error: "Nao foi possivel concluir a solicitacao." } };
  }
}
