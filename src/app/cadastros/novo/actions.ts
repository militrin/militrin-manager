"use server";

import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { assertPermission } from "@/lib/admin/permissions";
import { getCurrentOrganizationContext } from "@/lib/organizations/current-organization";
import { personRegistrationSchema, removeCpfMask } from "@/lib/validation/registration";
import { toISODateFromBR } from "@/lib/utils/date";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function novoCadastroHref(params: Record<string, string>, eventId: string) {
  const search = new URLSearchParams(params);
  if (uuid.test(eventId)) search.set("eventId", eventId);
  return `/cadastros/novo?${search.toString()}`;
}

export async function createContactAction(formData: FormData) {
  await assertPermission("participants.create");
  const eventId = String(formData.get("event_id") ?? "");
  const parsed = personRegistrationSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) redirect(novoCadastroHref({ erro: parsed.error.issues[0]?.message ?? "Dados inválidos" }, eventId));
  const organization = (await getCurrentOrganizationContext()).organization;
  if (!organization?.id) redirect(novoCadastroHref({ erro: "Selecione uma organização" }, eventId));
  const birthDate = toISODateFromBR(parsed.data.birth_date);
  if (!birthDate) redirect(novoCadastroHref({ erro: "Data de nascimento inválida" }, eventId));
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
  if (error || !data) redirect(novoCadastroHref({ erro: error?.message ?? "Cadastro não salvo" }, eventId));
  const contactId = String(data);
  const { data: contact } = await supabase.from("registration_contacts").select("public_pin").eq("id", contactId).maybeSingle();
  const { data: accountState } = await supabase.rpc("get_registration_contact_account_state", {
    p_registration_contact_id: contactId,
  });
  const row = (Array.isArray(accountState) ? accountState[0] : accountState) as { state?: string } | null;
  redirect(novoCadastroHref({
    sucesso: "1",
    pin: String(contact?.public_pin ?? ""),
    id: contactId,
    conta: String(row?.state ?? "none"),
  }, eventId));
}
