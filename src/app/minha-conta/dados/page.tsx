import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requestEmailChangeAction, updateMyProfileAction, updatePasswordAction } from '@/app/minha-conta/actions';
import { redirect } from 'next/navigation';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { formatISOToDateBR } from '@/lib/utils/date';
import { MilitrinAvatar, MilitrinButton, MilitrinSection } from '@/components/militrin';
import {
  resolveParticipantAvatarUrl,
  resolveParticipantFullName,
  resolveParticipantInitials,
} from '@/lib/account/participant-identity';
import { sanitizeInternalNextPath } from '@/lib/utils/safe-navigation';

export default async function DadosPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await createServerSupabaseClient();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const nextParamRaw = resolvedSearchParams?.next;
  const nextParam = Array.isArray(nextParamRaw) ? nextParamRaw[0] : nextParamRaw;
  const safeNext = sanitizeInternalNextPath(nextParam ?? null, '/minha-conta');
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profileData } = await supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null });
  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const birthDate = formatISOToDateBR(String(profile?.birth_date ?? ''));
  const userMetadata = (user?.user_metadata as Record<string, unknown> | undefined) ?? null;
  const photoUrl = resolveParticipantAvatarUrl({ profile, userMetadata });
  const displayName = resolveParticipantFullName({
    profile,
    userMetadata,
    email: user?.email,
  });

  async function saveProfileAction(formData: FormData) {
    'use server';
    const nextPath = sanitizeInternalNextPath(String(formData.get('next_path') ?? ''), '/minha-conta');
    await updateMyProfileAction(formData);
    redirect(nextPath);
  }

  async function changeEmailAction(formData: FormData) {
    'use server';
    await requestEmailChangeAction(formData);
  }

  async function changePasswordAction(formData: FormData) {
    'use server';
    await updatePasswordAction(formData);
  }

  return (
    <section className="space-y-4">
      <MilitrinSection
        eyebrow="Meu perfil"
        title="Dados do participante"
        description="Atualize dados publicos e preferencias de privacidade com seguranca."
      >
        <div className="mb-5 flex items-center gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <MilitrinAvatar src={photoUrl} alt={`Foto do participante ${displayName}`} initials={resolveParticipantInitials(displayName)} />
          <div>
            <p className="text-sm text-slate-300">Perfil ativo</p>
            <p className="text-lg font-semibold text-white" title={displayName}>{displayName}</p>
          </div>
        </div>

        <form action={saveProfileAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="next_path" value={safeNext} />
          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-slate-300">Nome completo</span>
            <input name="full_name" defaultValue={String(profile?.full_name ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <label className="space-y-1">
            <span className="text-sm text-slate-300">CPF</span>
            <input name="cpf" defaultValue={String(profile?.cpf ?? '')} readOnly className="h-11 w-full cursor-not-allowed rounded-2xl border border-slate-700 bg-slate-900/50 px-4 text-sm text-slate-300 outline-none" />
          </label>

          <BirthDateInput name="birth_date" value={birthDate} onChange={() => undefined} required disabled label="Nascimento" className="space-y-1" />

          <label className="space-y-1">
            <span className="text-sm text-slate-300">Genero</span>
            <select name="gender" defaultValue={String(profile?.gender ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400">
              <option value="">Selecione</option>
              <option value="male">Masculino</option>
              <option value="female">Feminino</option>
              <option value="other">Outro</option>
              <option value="prefer_not_to_say">Prefiro nao informar</option>
            </select>
          </label>

          <label className="space-y-1">
            <span className="text-sm text-slate-300">Telefone</span>
            <input name="phone" defaultValue={String(profile?.phone ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-slate-300">Cidade</span>
            <input name="city" defaultValue={String(profile?.city ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-slate-300">Foto de perfil (URL)</span>
            <input name="photo_url" type="url" placeholder="https://..." defaultValue={photoUrl ?? ''} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-slate-300">Visibilidade do perfil</span>
            <select name="profile_visibility" defaultValue={String(profile?.profile_visibility ?? 'participants')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400">
              <option value="participants">Participantes</option>
              <option value="friends">Amigos</option>
              <option value="private">Privado</option>
            </select>
          </label>

          <label className="flex items-start gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            <input name="show_in_participant_list" type="checkbox" defaultChecked={Boolean(profile?.show_in_participant_list ?? true)} className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950" />
            <span>Aparecer na lista de inscritos do evento.</span>
          </label>

          <label className="flex items-start gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            <input name="allow_friend_requests" type="checkbox" defaultChecked={Boolean(profile?.allow_friend_requests ?? true)} className="mt-1 h-4 w-4 rounded border-slate-600 bg-slate-950" />
            <span>Receber pedidos de amizade.</span>
          </label>

          <div className="sm:col-span-2">
            <MilitrinButton type="submit">Salvar dados</MilitrinButton>
          </div>
        </form>
      </MilitrinSection>

      <div className="grid gap-4 lg:grid-cols-2">
        <MilitrinSection eyebrow="Senha" title="Atualizar senha" description="Use pelo menos 8 caracteres para sua nova senha.">
          <form action={changePasswordAction} className="grid gap-3">
            <input name="new_password" type="password" minLength={8} required placeholder="Nova senha" className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <input name="confirm_password" type="password" minLength={8} required placeholder="Confirmar nova senha" className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <MilitrinButton type="submit" variant="success">Atualizar senha</MilitrinButton>
          </form>
        </MilitrinSection>

        <MilitrinSection eyebrow="E-mail" title="Trocar e-mail" description="A troca de e-mail usa fluxo seguro do Supabase Auth.">
          <form action={changeEmailAction} className="space-y-3">
            <input name="email" type="email" required defaultValue={String(profile?.email ?? user?.email ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
            <MilitrinButton type="submit" variant="secondary">Enviar confirmacao</MilitrinButton>
          </form>
        </MilitrinSection>
      </div>
    </section>
  );
}
