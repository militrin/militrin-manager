"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { personRegistrationSchema, removeCpfMask } from "@/lib/validation/registration";
import { toISODateFromBR } from "@/lib/utils/date";

export async function createContactAction(formData: FormData) {
  await assertPermission("participants.create");
  const parsed = personRegistrationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(`/cadastros/novo?erro=${encodeURIComponent(parsed.error.issues[0]?.message ?? "Dados inválidos")}`);
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect("/cadastros/novo?erro=Selecione uma organização");
  const birthDate = toISODateFromBR(parsed.data.birth_date);
  if (!birthDate) redirect("/cadastros/novo?erro=Data de nascimento inválida");
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc("create_registration_contact", {
    p_organization_id: organization.id,
    p_full_name: parsed.data.full_name,
    p_cpf: removeCpfMask(parsed.data.cpf),
    p_birth_date: birthDate,
    p_gender: parsed.data.gender || null,
    p_phone: parsed.data.phone,
    p_email: parsed.data.email,
    p_city: parsed.data.city || null,
  });
  if (error || !data) redirect(`/cadastros/novo?erro=${encodeURIComponent(error?.message ?? "Cadastro não salvo")}`);
  const { data: contact } = await supabase.from("registration_contacts").select("public_pin").eq("id", String(data)).maybeSingle();
  redirect(`/cadastros/novo?sucesso=1&pin=${encodeURIComponent(String(contact?.public_pin ?? ""))}`);
}
