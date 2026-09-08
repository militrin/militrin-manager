import { createHash } from "node:crypto";

export function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function extractRawEncodedCode(rawUrl: string) {
  let search = "";
  try {
    search = new URL(rawUrl).search;
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    search = queryIndex >= 0 ? rawUrl.slice(queryIndex) : "";
  }
  const query = search.startsWith("?") ? search.slice(1) : search;
  const match = /(?:^|&)code=([^&]*)/.exec(query);
  return match ? match[1] : null;
}

export function percentDecodePreservingPlus(encoded: string) {
  return encoded.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

export type InstagramOAuthCodeInspect = {
  rawPresent: boolean;
  rawEncodedLength: number | null;
  rawEncodedHash: string | null;
  rawHasLiteralPlus: boolean;
  rawHasPct2b: boolean;
  rawHasPct20: boolean;
  parsedPresent: boolean;
  parsedLength: number | null;
  parsedHash: string | null;
  parsedHasSpace: boolean;
  parsedHasPlus: boolean;
  plusPreservingLength: number | null;
  plusPreservingHash: string | null;
  plusPreservingParsedMatch: boolean | null;
};

export function inspectInstagramCallbackCode(rawUrl: string, parsedCode: string | null): InstagramOAuthCodeInspect {
  const rawEncoded = extractRawEncodedCode(rawUrl);
  const parsed = parsedCode ?? null;
  const plusPreserving = rawEncoded == null ? null : percentDecodePreservingPlus(rawEncoded);
  return {
    rawPresent: rawEncoded != null,
    rawEncodedLength: rawEncoded == null ? null : rawEncoded.length,
    rawEncodedHash: rawEncoded == null ? null : sha256Hex(rawEncoded),
    rawHasLiteralPlus: Boolean(rawEncoded?.includes("+")),
    rawHasPct2b: Boolean(rawEncoded?.toLowerCase().includes("%2b")),
    rawHasPct20: Boolean(rawEncoded?.toLowerCase().includes("%20")),
    parsedPresent: parsed != null,
    parsedLength: parsed == null ? null : parsed.length,
    parsedHash: parsed == null ? null : sha256Hex(parsed),
    parsedHasSpace: Boolean(parsed?.includes(" ")),
    parsedHasPlus: Boolean(parsed?.includes("+")),
    plusPreservingLength: plusPreserving == null ? null : plusPreserving.length,
    plusPreservingHash: plusPreserving == null ? null : sha256Hex(plusPreserving),
    plusPreservingParsedMatch: plusPreserving == null || parsed == null ? null : plusPreserving === parsed,
  };
}

export function inspectInstagramCodeTrim(parsedCode: string) {
  const trimmed = parsedCode.trim();
  return {
    parsedLength: parsedCode.length,
    parsedHash: sha256Hex(parsedCode),
    trimmedLength: trimmed.length,
    trimmedHash: sha256Hex(trimmed),
    trimChanged: parsedCode !== trimmed,
    sentLength: trimmed.length,
    sentHash: sha256Hex(trimmed),
    sentMatchesParsed: parsedCode === trimmed,
  };
}

export function inspectInstagramAppSecret(raw: string | undefined) {
  const value = raw ?? "";
  const hash = value ? sha256Hex(value) : null;
  return {
    present: value.length > 0,
    length: value.length,
    hasLeadingWhitespace: value !== value.trimStart(),
    hasTrailingWhitespace: value !== value.trimEnd(),
    hasCrLf: /[\r\n]/.test(value),
    sha256: hash,
    hashPrefix: hash ? hash.slice(0, 8) : null,
  };
}
