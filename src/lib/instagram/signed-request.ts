import { createHmac, timingSafeEqual } from "node:crypto";

export const META_SIGNED_REQUEST_ALGORITHM = "HMAC-SHA256";

export type MetaSignedRequestPayload = {
  algorithm: typeof META_SIGNED_REQUEST_ALGORITHM;
  user_id: string;
};

export type ParseMetaSignedRequestResult =
  | { ok: true; payload: MetaSignedRequestPayload }
  | { ok: false; status: 400 | 401; reason: "malformed" | "algorithm" | "signature" };

function decodeBase64Url(value: string): Buffer | null {
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function signaturesMatch(actual: Buffer, expected: Buffer): boolean {
  if (actual.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

function parseUserId(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const asString = String(Math.trunc(value));
    return asString.length > 0 ? asString : null;
  }
  if (typeof value !== "string") return null;
  const userId = value.trim();
  if (!userId || userId.length > 128) return null;
  return userId;
}

export function parseMetaSignedRequest(signedRequest: string, appSecret: string): ParseMetaSignedRequestResult {
  if (!appSecret || typeof signedRequest !== "string") {
    return { ok: false, status: 400, reason: "malformed" };
  }

  const separator = signedRequest.indexOf(".");
  if (separator <= 0 || signedRequest.indexOf(".", separator + 1) !== -1) {
    return { ok: false, status: 400, reason: "malformed" };
  }

  const encodedSignature = signedRequest.slice(0, separator);
  const encodedPayload = signedRequest.slice(separator + 1);
  if (!encodedSignature || !encodedPayload) {
    return { ok: false, status: 400, reason: "malformed" };
  }

  const signature = decodeBase64Url(encodedSignature);
  const payloadBytes = decodeBase64Url(encodedPayload);
  if (!signature || !payloadBytes) {
    return { ok: false, status: 400, reason: "malformed" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return { ok: false, status: 400, reason: "malformed" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, status: 400, reason: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  if (record.algorithm !== META_SIGNED_REQUEST_ALGORITHM) {
    return { ok: false, status: 400, reason: "algorithm" };
  }

  const expected = createHmac("sha256", appSecret).update(encodedPayload).digest();
  if (!signaturesMatch(signature, expected)) {
    return { ok: false, status: 401, reason: "signature" };
  }

  const userId = parseUserId(record.user_id);
  if (!userId) {
    return { ok: false, status: 400, reason: "malformed" };
  }

  return {
    ok: true,
    payload: {
      algorithm: META_SIGNED_REQUEST_ALGORITHM,
      user_id: userId,
    },
  };
}

export function readSignedRequestFromUrlEncodedBody(body: string): string | null {
  const value = new URLSearchParams(body).get("signed_request");
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
