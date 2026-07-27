import { createServerSupabaseClient } from '@/lib/supabase/server';
import { requestEmailChangeAction, updateMyProfileAction } from '@/app/minha-conta/actions';
import { BirthDateInput } from '@/components/forms/BirthDateInput';
import { formatISOToDateBR } from '@/lib/utils/date';

export default async function DadosPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profileData } = await supabase.rpc('get_customer_profile', { p_user_id: user?.id ?? null });
  const profile = (Array.isArray(profileData) ? profileData[0] : profileData) as Record<string, unknown> | null;
  const birthDate = formatISOToDateBR(String(profile?.birth_date ?? ''));

  async function saveProfileAction(formData: FormData) {
    'use server';
    await updateMyProfileAction(formData);
  }

  async function changeEmailAction(formData: FormData) {
    'use server';
    await requestEmailChangeAction(formData);
  }

  return (
    <section className="space-y-5">
      <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">Seus dados</p>
        <h2 className="mt-2 text-3xl font-semibold text-white">Perfil do participante</h2>
        <p className="mt-2 max-w-2xl text-sm text-slate-300">Atualize seus dados públicos e preferências de privacidade. O e-mail é alterado por um fluxo seguro separado.</p>

        <form action={saveProfileAction} className="mt-6 grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 sm:col-span-2">
            <span className="text-sm text-slate-300">Nome completo</span>
            <input name="full_name" defaultValue={String(profile?.full_name ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <label className="space-y-1">
            <span className="text-sm text-slate-300">CPF</span>
            <input name="cpf" defaultValue={String(profile?.cpf ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          </label>

          <BirthDateInput name="birth_date" value={birthDate} onChange={() => undefined} required disabled label="Nascimento" className="space-y-1" />

          <label className="space-y-1">
            <span className="text-sm text-slate-300">Gênero</span>
            <select name="gender" defaultValue={String(profile?.gender ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400">
              <option value="">Selecione</option>
              <option value="male">Masculino</option>
              <option value="female">Feminino</option>
              <option value="other">Outro</option>
              <option value="prefer_not_to_say">Prefiro não informar</option>
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
            <button type="submit" className="h-11 rounded-2xl bg-emerald-400 px-5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-300">
              Salvar dados
            </button>
          </div>
        </form>
      </div>

      <div className="rounded-[2rem] border border-slate-800/80 bg-slate-900/70 p-6 shadow-lg shadow-black/10">
        <p className="text-xs uppercase tracking-[0.22em] text-emerald-300">E-mail</p>
        <h3 className="mt-2 text-2xl font-semibold text-white">Trocar endereço de e-mail</h3>
        <p className="mt-2 text-sm text-slate-300">A alteração ocorre pelo Supabase Auth. Só atualize o perfil depois que a confirmação for concluída.</p>

        <form action={changeEmailAction} className="mt-5 flex flex-col gap-3 sm:flex-row">
          <input name="email" type="email" required defaultValue={String(profile?.email ?? user?.email ?? '')} className="h-11 w-full rounded-2xl border border-slate-700 bg-slate-950 px-4 text-sm text-slate-100 outline-none focus:border-emerald-400" />
          <button type="submit" className="h-11 rounded-2xl border border-emerald-400/40 bg-emerald-400/10 px-5 text-sm font-semibold text-emerald-200 transition hover:bg-emerald-400/20">
            Enviar confirmação
          </button>
        </form>
      </div>
    </section>
  );
}