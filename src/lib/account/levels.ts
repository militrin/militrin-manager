export type LoyaltyLevel = {
  slug: string;
  name: string;
  badge: string;
  minConfirmedParticipations: number;
  sortOrder?: number;
};

const FALLBACK_LOYALTY_LEVEL: LoyaltyLevel = {
  slug: 'novato',
  name: 'Novato',
  badge: 'N',
  minConfirmedParticipations: 0,
};

export function normalizeLoyaltyLevel(level: Record<string, unknown>): LoyaltyLevel {
  return {
    slug: String(level.slug ?? 'novato'),
    name: String(level.name ?? 'Novato'),
    badge: String(level.badge ?? 'N'),
    minConfirmedParticipations: Number(level.min_confirmed_participations ?? level.minConfirmedParticipations ?? 0),
    sortOrder: Number(level.sort_order ?? level.sortOrder ?? 0),
  };
}

export function sortLoyaltyLevels(levels: LoyaltyLevel[]) {
  return [...levels].sort((left, right) => {
    const byParticipation = left.minConfirmedParticipations - right.minConfirmedParticipations;
    if (byParticipation !== 0) return byParticipation;
    return (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
  });
}

export function getLoyaltyLevel(confirmedParticipations: number, levels: LoyaltyLevel[]) {
  const sorted = sortLoyaltyLevels(levels);
  if (!sorted.length) return FALLBACK_LOYALTY_LEVEL;

  return sorted.filter((level) => confirmedParticipations >= level.minConfirmedParticipations).at(-1) ?? sorted[0] ?? FALLBACK_LOYALTY_LEVEL;
}

export function getNextLoyaltyLevel(confirmedParticipations: number, levels: LoyaltyLevel[]) {
  const sorted = sortLoyaltyLevels(levels);
  return sorted.find((level) => level.minConfirmedParticipations > confirmedParticipations) ?? null;
}

export function getLoyaltyProgress(confirmedParticipations: number, levels: LoyaltyLevel[]) {
  const current = getLoyaltyLevel(confirmedParticipations, levels);
  const next = getNextLoyaltyLevel(confirmedParticipations, levels);
  if (!next) {
    const isLegend = current.slug.toLowerCase() === 'legend-militrin';
    return {
      current,
      next: null,
      completed: isLegend,
      progress: isLegend ? 100 : 0,
      remaining: 0,
    };
  }

  const previousFloor = current.minConfirmedParticipations;
  const range = Math.max(1, next.minConfirmedParticipations - previousFloor);
  const rawProgress = ((confirmedParticipations - previousFloor) / range) * 100;

  return {
    current,
    next,
    completed: false,
    progress: Math.min(100, Math.max(0, rawProgress)),
    remaining: Math.max(0, next.minConfirmedParticipations - confirmedParticipations),
  };
}