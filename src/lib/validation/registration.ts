import { z } from "zod";
import { SHIRT_SIZES, SHIRT_TYPES } from "@/lib/constants/shirts";

const cpfRegex = /^\d{11}$/;

export function removeCpfMask(value: string) {
  return value.replace(/\D/g, "");
}

export function formatCpf(value: string) {
  const digits = removeCpfMask(value).slice(0, 11);
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)}.${digits.slice(3)}`;
  if (digits.length <= 9) return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

export function formatPhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, 11);
  if (digits.length <= 2) return `(${digits}`;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

export function calculateAge(birthDate: string) {
  const birth = new Date(birthDate);
  const today = new Date();
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age -= 1;
  }
  return age;
}

export function isValidCpf(value: string) {
  const cpf = removeCpfMask(value);
  if (!cpfRegex.test(cpf)) return false;

  const repeated = /^(\d)\1{10}$/.test(cpf);
  if (repeated) return false;

  const digits = cpf.split("").map(Number);
  const calculateDigit = (factor: number) => {
    const sum = digits.slice(0, factor - 1).reduce((acc, digit, index) => acc + digit * (factor - index), 0);
    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  const firstDigit = calculateDigit(10);
  const secondDigit = calculateDigit(11);
  return digits[9] === firstDigit && digits[10] === secondDigit;
}

export const registrationSchema = z.object({
  full_name: z.string().trim().min(3, "Informe o nome completo."),
  cpf: z.string().trim().min(11, "CPF é obrigatório."),
  birth_date: z.string().min(1, "Informe a data de nascimento."),
  gender: z.string().optional(),
  phone: z.string().trim().min(10, "Telefone é obrigatório."),
  email: z.string().trim().email("E-mail inválido.").optional().or(z.literal("")),
  city: z.string().trim().optional(),
  shirt_type: z.string().refine((value) => SHIRT_TYPES.includes(value as (typeof SHIRT_TYPES)[number]), {
    message: "Selecione o modelo de camiseta.",
  }),
  shirt_size: z.string().min(1, "Selecione o tamanho."),
  payment_method: z.string().min(1, "Selecione a forma de pagamento."),
  amount: z.string().min(1, "Informe o valor."),
  payment_status: z.string().min(1, "Selecione o status do pagamento."),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  if (!isValidCpf(data.cpf)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cpf"], message: "CPF inválido." });
  }

  const age = calculateAge(data.birth_date);
  if (age < 18) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["birth_date"], message: "A inscrição exige idade mínima de 18 anos." });
  }

  const allowedSizes = (SHIRT_SIZES as Record<string, readonly string[]>)[data.shirt_type] ?? [];
  if (!allowedSizes.includes(data.shirt_size)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shirt_size"], message: "Tamanho não permitido para este modelo." });
  }

  const amount = Number(data.amount.replace(/[^\d.]/g, ""));
  if (Number.isNaN(amount) || amount < 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amount"], message: "O valor deve ser maior ou igual a zero." });
  }
});

export type RegistrationFormValues = z.infer<typeof registrationSchema>;
