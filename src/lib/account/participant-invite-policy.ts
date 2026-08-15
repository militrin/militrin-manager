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

  const expiresAtMs = new Date(String(input.expiresAt ?? '')).getTime();
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= (input.nowMs ?? Date.now())) return 'inactive';

  if (input.participantUserId && input.participantUserId !== input.userId) return 'participant_conflict';

  const authEmail = String(input.userEmail ?? '').trim().toLowerCase();
  const inviteEmail = String(input.inviteEmail ?? '').trim().toLowerCase();
  const explicitlyCorrelated = input.authUserId
    ? input.authUserId === input.userId
    : input.metadataInviteId === input.inviteId;

  if (!authEmail || authEmail !== inviteEmail || !explicitlyCorrelated) return 'wrong_session';
  return null;
}

