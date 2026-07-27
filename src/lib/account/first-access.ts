import { getProfileCompletionStatus } from '@/lib/account/profile-completion';

export type FirstAccessFlags = {
  mustChangePassword: boolean;
  mustCompleteProfile: boolean;
  accountStatus: string | null;
  missingRequiredFields: string[];
  hasProfile: boolean;
  isBlocked: boolean;
  firstAccessRequired: boolean;
  isComplete: boolean;
  error: string | null;
};

export async function getFirstAccessFlags(userId: string, authEmail?: string | null) {
  const status = await getProfileCompletionStatus(userId, authEmail ?? null);
  if (status.error) {
    return {
      mustChangePassword: false,
      mustCompleteProfile: false,
      accountStatus: null as string | null,
      missingRequiredFields: [] as string[],
      hasProfile: false,
      isBlocked: false,
      firstAccessRequired: false,
      isComplete: false,
      error: status.error,
    };
  }

  const accountStatus = status.profile?.account_status ? String(status.profile.account_status) : null;
  const isBlocked = accountStatus === 'blocked';
  const firstAccessRequired = !isBlocked && !status.isComplete;

  return {
    mustChangePassword: status.mustChangePassword,
    mustCompleteProfile: status.mustCompleteProfile,
    accountStatus,
    missingRequiredFields: status.missingFields,
    hasProfile: status.exists,
    isBlocked,
    firstAccessRequired,
    isComplete: status.isComplete,
    error: null,
  };
}
