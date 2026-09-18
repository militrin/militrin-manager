const INVITE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function firstAccessOnboardingPath(inviteId: string) {
  // Somente `invite`. Um `&next=` extra vira query irmao depois que
  // searchParams decodifica `%26` no RedirectTo do template.
  return `/primeiro-acesso?invite=${encodeURIComponent(inviteId)}`;
}

export function parseInviteId(value: string | null | undefined) {
  const raw = String(value ?? '').trim();
  return INVITE_UUID.test(raw) ? raw : null;
}

export function inviteIdFromInternalPath(path: string | null | undefined) {
  const raw = String(path ?? '').trim();
  if (!raw.startsWith('/')) return null;
  try {
    const parsed = new URL(raw, 'http://localhost');
    if (parsed.pathname !== '/primeiro-acesso') return null;
    return parseInviteId(parsed.searchParams.get('invite'));
  } catch {
    return null;
  }
}

export function chooseFirstAccessInviteId(input: {
  urlInviteId: string | null;
  metadataInviteId: string | null;
  liveInviteIds: string[];
}) {
  const urlInviteId = parseInviteId(input.urlInviteId);
  const metadataInviteId = parseInviteId(input.metadataInviteId);
  const liveInviteIds = input.liveInviteIds.map((id) => parseInviteId(id)).filter((id): id is string => Boolean(id));

  if (urlInviteId) {
    return {
      inviteId: urlInviteId,
      source: 'url' as const,
      ignoredStaleMetadata: Boolean(metadataInviteId && metadataInviteId !== urlInviteId),
    };
  }

  if (liveInviteIds.length === 0) {
    return {
      inviteId: null,
      source: 'none' as const,
      ignoredStaleMetadata: Boolean(metadataInviteId),
    };
  }

  if (metadataInviteId && liveInviteIds.includes(metadataInviteId)) {
    return {
      inviteId: metadataInviteId,
      source: 'live' as const,
      ignoredStaleMetadata: false,
    };
  }

  return {
    inviteId: liveInviteIds[0],
    source: 'live' as const,
    ignoredStaleMetadata: Boolean(metadataInviteId && !liveInviteIds.includes(metadataInviteId)),
  };
}
