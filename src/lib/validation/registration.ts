import { z } from "zod";
import { SHIRT_SIZES, SHIRT_TYPES } from "@/lib/constants/shirts";
import { calculateAgeFromDateBR, isValidDateBR, parseDateInput } from "@/lib/utils/date";

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
  return calculateAgeFromDateBR(birthDate);
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
  email: z.string().trim().min(1, "E-mail é obrigatório.").email("E-mail inválido."),
  city: z.string().trim().optional(),
  shirt_type: z.string().optional(),
  shirt_size: z.string().optional(),
  has_shirt_item: z.boolean().optional(),
  ticket_category_id: z.string().uuid("Selecione uma categoria de acesso válida."),
  payment_method: z.string().min(1, "Selecione a forma de pagamento."),
  coupon_code: z.string().trim().max(60, "Código de cupom muito longo.").optional().or(z.literal("")),
  notes: z.string().optional(),
}).superRefine((data, ctx) => {
  if (!isValidCpf(data.cpf)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["cpf"], message: "CPF inválido." });
  }

  if (!isValidDateBR(data.birth_date)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["birth_date"], message: "Informe uma data válida no formato dd/MM/aaaa." });
    return;
  }

  const parsedBirthDate = parseDateInput(data.birth_date);
  if (!parsedBirthDate || parsedBirthDate.getTime() > Date.now()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["birth_date"], message: "Informe uma data válida no formato dd/MM/aaaa." });
    return;
  }

  const age = calculateAge(data.birth_date);
  if (age < 18) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["birth_date"], message: "A inscrição exige idade mínima de 18 anos." });
  }

  if (data.has_shirt_item) {
    if (!data.shirt_type || !SHIRT_TYPES.includes(data.shirt_type as (typeof SHIRT_TYPES)[number])) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shirt_type"], message: "Selecione o modelo de camiseta." });
      return;
    }

    const allowedSizes = (SHIRT_SIZES as Record<string, readonly string[]>)[data.shirt_type] ?? [];
    if (!data.shirt_size || !allowedSizes.includes(data.shirt_size)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["shirt_size"], message: "Tamanho não permitido para este modelo." });
    }
  }
});

export type RegistrationFormValues = z.infer<typeof registrationSchema> & {
  has_shirt_item?: boolean;
};

export function validateShirtSelection(values: { has_shirt_item?: boolean; shirt_type?: string; shirt_size?: string }) {
  if (!values.has_shirt_item) return null;

  const shirtType = values.shirt_type ?? "";
  const shirtSize = values.shirt_size ?? "";

  if (!SHIRT_TYPES.includes(shirtType as (typeof SHIRT_TYPES)[number])) {
    return "Selecione o modelo de camiseta.";
  }

  const allowedSizes = (SHIRT_SIZES as Record<string, readonly string[]>)[shirtType] ?? [];
  if (!shirtSize || !allowedSizes.includes(shirtSize)) {
    return "Tamanho não permitido para este modelo.";
  }

  return null;
}
