type UnknownRecord = Record<string, unknown>;

const CONNECTORS = new Set(['da', 'de', 'do', 'das', 'dos']);

function asText(value: unknown) {
  return String(value ?? '').trim();
}

export function resolveParticipantFullName(input: {
  profile: UnknownRecord | null;
  userMetadata: UnknownRecord | null;
  email: string | null | undefined;
}) {
  const profileName = asText(input.profile?.full_name);
  if (profileName) return profileName;

  const metadataFullName = asText(input.userMetadata?.full_name);
  if (metadataFullName) return metadataFullName;

  const metadataName = asText(input.userMetadata?.name);
  if (metadataName) return metadataName;

  const normalizedEmail = asText(input.email).toLowerCase();
  if (normalizedEmail.includes('@')) {
    const local = normalizedEmail.split('@')[0] ?? '';
    return local ? local : 'Participante';
  }

  return normalizedEmail || 'Participante';
}

export function resolveParticipantFirstName(fullName: string) {
  const normalized = asText(fullName);
  if (!normalized) return 'Participante';
  const first = normalized.split(/\s+/).find(Boolean);
  return first || 'Participante';
}

export function resolveParticipantInitials(fullName: string) {
  const normalized = asText(fullName);
  if (!normalized) return 'P';

  const parts = normalized
    .split(/\s+/)
    .map((chunk) => chunk.trim())
    .filter(Boolean);

  if (parts.length === 1) {
    return parts[0].slice(0, 1).toUpperCase();
  }

  const filtered = parts.filter((chunk) => !CONNECTORS.has(chunk.toLowerCase()));
  const source = filtered.length > 0 ? filtered : parts;

  const first = source[0]?.slice(0, 1) ?? '';
  const last = source.at(-1)?.slice(0, 1) ?? '';

  return `${first}${last}`.toUpperCase() || 'P';
}

export function resolveParticipantAvatarUrl(input: {
  profile: UnknownRecord | null;
  userMetadata: UnknownRecord | null;
}) {
  const profileAvatar = asText(input.profile?.avatar_url);
  if (profileAvatar) return profileAvatar;

  const metadataAvatar = asText(input.userMetadata?.avatar_url);
  if (metadataAvatar) return metadataAvatar;

  return null;
}
