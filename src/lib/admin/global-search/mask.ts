import { maskCpf as maskCpfCompact } from "../../imports/normalization.ts";
import { maskWristbandCode } from "../../operations/history/fold-events.ts";

export function maskCpfForSearch(cpf: string | null | undefined) {
  const digits = String(cpf ?? "").replace(/\D/g, "");
  if (digits.length !== 11) return maskCpfCompact(cpf);
  return `•••.•••.•••-${digits.slice(-2)}`;
}

export function maskWristbandForSearch(code: string | null | undefined) {
  const value = String(code ?? "").trim();
  if (value.length >= 8) {
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
  }
  return maskWristbandCode(value) ?? "••••";
}

export function formatSearchStatus(label: string | null | undefined) {
  const value = String(label ?? "").trim();
  return value ? value.toLocaleUpperCase("pt-BR") : null;
}
