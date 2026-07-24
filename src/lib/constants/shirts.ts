export const SHIRT_TYPES = ["Camiseta", "Babylook"] as const;

export const SHIRT_SIZES = {
  Camiseta: ["PP", "P", "M", "G", "GG", "EG", "EXG", "EXGG"],
  Babylook: ["PP", "P", "M", "G", "GG", "EG"],
} as const;

export type ShirtType = (typeof SHIRT_TYPES)[number];
export type ShirtSize = (typeof SHIRT_SIZES)[ShirtType][number];
