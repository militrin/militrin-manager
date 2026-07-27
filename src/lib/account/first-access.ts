import { getProfileCompletionStatus } from '@/lib/account/profile-completion';

export async function getFirstAccessFlags(userId: string, authEmail?: string | null) {
  const status = await getProfileCompletionStatus(userId, authEmail ?? null);
  if (status.error) {
    return {
      mustChangePassword: false,
      mustCompleteProfile: false,
      accountStatus: null as string | null,
      missingRequiredFields: [] as string[],
      hasProfile: false,
    };
  }

  return {
    mustChangePassword: status.mustChangePassword,
    mustCompleteProfile: status.mustCompleteProfile || status.missingFields.length > 0 || !status.exists,
    accountStatus: status.profile?.account_status ? String(status.profile.account_status) : null,
    missingRequiredFields: status.missingFields,
    hasProfile: status.exists,
  };
}
