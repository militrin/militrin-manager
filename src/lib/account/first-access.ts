import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function getFirstAccessFlags(userId: string) {
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('get_customer_profile', {
    p_user_id: userId,
  });

  if (error) {
    return {
      mustChangePassword: false,
      mustCompleteProfile: false,
      accountStatus: null as string | null,
    };
  }

  const profile = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;

  return {
    mustChangePassword: Boolean(profile?.must_change_password),
    mustCompleteProfile: Boolean(profile?.must_complete_profile),
    accountStatus: profile?.account_status ? String(profile.account_status) : null,
  };
}
