type SupabaseUpdateResult = {
  error: { message: string } | null;
};

type CustomerProfilesTableClient = {
  update: (values: Record<string, unknown>) => {
    eq: (column: string, value: string) => unknown;
  };
};

type SupabaseLike = {
  from: (table: 'customer_profiles') => CustomerProfilesTableClient;
};

function extractMissingCustomerProfilesColumn(message: string) {
  const cacheMatch = message.match(/could not find the '([^']+)' column of 'customer_profiles'/i);
  if (cacheMatch?.[1]) {
    return cacheMatch[1];
  }

  const notExistsMatch = message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i);
  if (notExistsMatch?.[1]) {
    return notExistsMatch[1];
  }

  return null;
}

export async function updateCustomerProfileCompat(
  supabase: SupabaseLike,
  userId: string,
  payload: Record<string, unknown>,
): Promise<{ error: { message: string } | null; appliedColumns: string[] }> {
  const candidatePayload: Record<string, unknown> = { ...payload };

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const keys = Object.keys(candidatePayload);
    if (!keys.length) {
      const fallback = await supabase
        .from('customer_profiles')
        .update({ updated_at: new Date().toISOString() })
        .eq('user_id', userId) as SupabaseUpdateResult;

      return { error: fallback.error, appliedColumns: ['updated_at'] };
    }

    const result = await supabase
      .from('customer_profiles')
      .update(candidatePayload)
      .eq('user_id', userId) as SupabaseUpdateResult;

    if (!result.error) {
      return { error: null, appliedColumns: keys };
    }

    const missingColumn = extractMissingCustomerProfilesColumn(result.error.message);
    if (!missingColumn || !(missingColumn in candidatePayload)) {
      return { error: result.error, appliedColumns: keys };
    }

    delete candidatePayload[missingColumn];
  }

  return {
    error: { message: 'Nao foi possivel atualizar customer_profiles por incompatibilidade de schema.' },
    appliedColumns: Object.keys(candidatePayload),
  };
}
