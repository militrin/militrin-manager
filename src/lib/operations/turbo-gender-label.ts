const GENDER_COPY: Record<string, string> = {
  male: "Masculino",
  masculino: "Masculino",
  female: "Feminino",
  feminino: "Feminino",
  other: "Outro",
  outro: "Outro",
  prefer_not_to_say: "Prefiro não informar",
};

export function turboGenderLabel(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw || raw.toLowerCase() === "null" || raw.toLowerCase() === "undefined") return "Não informado";
  const mapped = GENDER_COPY[raw.toLowerCase().replace(/\s+/g, "_")];
  if (mapped) return mapped;
  if (/^[a-z][a-z0-9_]*$/.test(raw)) return "Não informado";
  return raw;
}
