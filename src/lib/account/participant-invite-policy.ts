export type InviteAccessReason =
  | 'inactive'
  | 'wrong_session'
  | 'participant_conflict';

type InviteAccessInput = {
  inviteId: string;
  inviteStatus: string;
  expiresAt: string | null;
  inviteEmail: string | null;
  authUserId: string | null;
  claimedUserId: string | null;
  participantUserId: string | null;
  userId: string;
  userEmail: string | null;
  metadataInviteId: string | null;
  nowMs?: number;
};

export function evaluateParticipantInviteAccess(input: InviteAccessInput): InviteAccessReason | null {
  if (input.inviteStatus === 'claimed') {
    if (input.claimedUserId !== input.userId || input.authUserId !== input.userId) {
      return 'wrong_session';
    }
    return input.participantUserId === input.userId ? null : 'participant_conflict';
  }

  if (input.inviteStatus !== 'pending') return 'inactive';

  if (input.participantUserId && input.participantUserId !== input.userId) return 'participant_conflict';

  const authEmail = String(input.userEmail ?? '').trim().toLowerCase();
  const inviteEmail = String(input.inviteEmail ?? '').trim().toLowerCase();
  const authBound = Boolean(input.authUserId && input.authUserId === input.userId);
  const metadataBound = !input.authUserId && input.metadataInviteId === input.inviteId;
  const explicitlyCorrelated = authBound || metadataBound;

  if (!authEmail || !explicitlyCorrelated) return 'wrong_session';
  if (!authBound && authEmail !== inviteEmail) return 'wrong_session';

  const expiresAtMs = new Date(String(input.expiresAt ?? '')).getTime();
  if (!authBound && (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now()))) {
    return 'inactive';
  }
  return null;
}

