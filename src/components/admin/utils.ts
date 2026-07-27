export function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export function maskCpf(cpf: string | null | undefined) {
  const digits = String(cpf ?? '').replace(/\D/g, '');
  if (digits.length !== 11) return cpf ?? '-';
  return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
}
