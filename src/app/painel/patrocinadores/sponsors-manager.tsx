'use client';

import { useState, useTransition } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { SponsorBannerUpload } from '@/components/admin/SponsorBannerUpload';
import {
  listSponsorsForAdminAction,
  moveSponsorAction,
  searchSponsorCandidateUsersAction,
  setSponsorBannerAction,
  setSponsorCarouselIntervalAction,
  setSponsorCarouselOrderModeAction,
  setSponsorUserAction,
  upsertSponsorAction,
} from './actions';

export type AdminSponsorRow = {
  sponsor_id: string;
  name: string;
  banner_url: string | null;
  link_url: string | null;
  is_active: boolean;
  sort_order: number;
  user_id: string | null;
  user_full_name: string | null;
  user_email: string | null;
};

type SponsorCandidate = { user_id: string; full_name: string; masked_email: string | null };

const emptyForm = { name: '', isActive: true, sortOrder: '0', linkUrl: '' };

export function SponsorsManager({
  initialSponsors,
  initialCarouselIntervalSeconds,
  initialCarouselOrderMode,
}: {
  initialSponsors: AdminSponsorRow[];
  initialCarouselIntervalSeconds: number;
  initialCarouselOrderMode: 'random' | 'manual';
}) {
  const [sponsors, setSponsors] = useState(initialSponsors);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [candidateTerm, setCandidateTerm] = useState('');
  const [candidates, setCandidates] = useState<SponsorCandidate[]>([]);
  const [intervalSeconds, setIntervalSeconds] = useState(String(initialCarouselIntervalSeconds));
  const [orderMode, setOrderMode] = useState<'random' | 'manual'>(initialCarouselOrderMode);

  const activeSponsorsInOrder = sponsors
    .filter((sponsor) => sponsor.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));

  const editingSponsor = editingId ? sponsors.find((sponsor) => sponsor.sponsor_id === editingId) ?? null : null;

  function resetForm() {
    setEditingId(null);
    setForm(emptyForm);
    setCandidates([]);
    setCandidateTerm('');
  }

  function loadForEdit(sponsor: AdminSponsorRow) {
    setEditingId(sponsor.sponsor_id);
    setForm({ name: sponsor.name, isActive: sponsor.is_active, sortOrder: String(sponsor.sort_order), linkUrl: sponsor.link_url ?? '' });
    setCandidates([]);
    setCandidateTerm('');
    setMessage(null);
  }

  function submitForm() {
    setMessage(null);
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: 'Informe o nome do patrocinador.' });
      return;
    }

    startTransition(async () => {
      const result = await upsertSponsorAction({
        id: editingId,
        name: form.name,
        isActive: form.isActive,
        sortOrder: Number(form.sortOrder || 0),
        linkUrl: form.linkUrl.trim() || null,
      });

      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success && 'sponsorId' in result) {
        const sponsorId = result.sponsorId;
        setSponsors((prev) => {
          const existing = prev.find((sponsor) => sponsor.sponsor_id === sponsorId);
          const updated: AdminSponsorRow = {
            sponsor_id: sponsorId,
            name: form.name.trim(),
            banner_url: existing?.banner_url ?? null,
            link_url: form.linkUrl.trim() || null,
            is_active: form.isActive,
            sort_order: Number(form.sortOrder || 0),
            user_id: existing?.user_id ?? null,
            user_full_name: existing?.user_full_name ?? null,
            user_email: existing?.user_email ?? null,
          };
          const rest = prev.filter((sponsor) => sponsor.sponsor_id !== sponsorId);
          return [...rest, updated].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
        });
        setEditingId(sponsorId);
      }
    });
  }

  function toggleActive(sponsor: AdminSponsorRow) {
    startTransition(async () => {
      const result = await upsertSponsorAction({
        id: sponsor.sponsor_id,
        name: sponsor.name,
        isActive: !sponsor.is_active,
        sortOrder: sponsor.sort_order,
        linkUrl: sponsor.link_url,
      });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) {
        setSponsors((prev) => prev.map((row) => (row.sponsor_id === sponsor.sponsor_id ? { ...row, is_active: !row.is_active } : row)));
      }
    });
  }

  function onBannerChange(url: string | null) {
    if (!editingSponsor) return;
    startTransition(async () => {
      const result = await setSponsorBannerAction({ sponsorId: editingSponsor.sponsor_id, bannerUrl: url });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) {
        setSponsors((prev) => prev.map((row) => (row.sponsor_id === editingSponsor.sponsor_id ? { ...row, banner_url: url } : row)));
      }
    });
  }

  function searchCandidates() {
    if (candidateTerm.trim().length < 3) {
      setMessage({ type: 'error', text: 'Informe ao menos 3 caracteres para buscar.' });
      return;
    }
    startTransition(async () => {
      const result = await searchSponsorCandidateUsersAction(candidateTerm);
      if (!result.success) {
        setMessage({ type: 'error', text: result.message ?? 'Falha ao buscar contas.' });
        return;
      }
      setCandidates(result.candidates as SponsorCandidate[]);
    });
  }

  function linkUser(candidate: SponsorCandidate) {
    if (!editingSponsor) return;
    startTransition(async () => {
      const result = await setSponsorUserAction({ sponsorId: editingSponsor.sponsor_id, userId: candidate.user_id });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) {
        setSponsors((prev) => prev.map((row) => (row.sponsor_id === editingSponsor.sponsor_id
          ? { ...row, user_id: candidate.user_id, user_full_name: candidate.full_name, user_email: candidate.masked_email }
          : row)));
        setCandidates([]);
        setCandidateTerm('');
      }
    });
  }

  function unlinkUser() {
    if (!editingSponsor) return;
    startTransition(async () => {
      const result = await setSponsorUserAction({ sponsorId: editingSponsor.sponsor_id, userId: null });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) {
        setSponsors((prev) => prev.map((row) => (row.sponsor_id === editingSponsor.sponsor_id ? { ...row, user_id: null, user_full_name: null, user_email: null } : row)));
      }
    });
  }

  function saveInterval() {
    const parsed = Number(intervalSeconds);
    if (!Number.isFinite(parsed) || parsed < 2 || parsed > 30) {
      setMessage({ type: 'error', text: 'Intervalo deve estar entre 2 e 30 segundos.' });
      return;
    }
    startTransition(async () => {
      const result = await setSponsorCarouselIntervalAction(parsed);
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
    });
  }

  function changeOrderMode(mode: 'random' | 'manual') {
    const previous = orderMode;
    setOrderMode(mode);
    startTransition(async () => {
      const result = await setSponsorCarouselOrderModeAction(mode);
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (!result.success) setOrderMode(previous);
    });
  }

  async function refreshSponsors() {
    const result = await listSponsorsForAdminAction();
    if (result.success) setSponsors(result.sponsors as AdminSponsorRow[]);
  }

  function moveSponsor(sponsorId: string, direction: 'up' | 'down') {
    startTransition(async () => {
      const result = await moveSponsorAction({ sponsorId, direction });
      setMessage({ type: result.success ? 'success' : 'error', text: result.message ?? '' });
      if (result.success) await refreshSponsors();
    });
  }

  return (
    <div className="space-y-6">
      {message ? (
        <div className={`rounded-xl border px-3 py-2 text-sm ${message.type === 'success' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200' : 'border-red-500/30 bg-red-500/10 text-red-200'}`}>
          {message.text}
        </div>
      ) : null}

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">Rotação do carrossel na Home</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Intervalo (segundos)</span>
            <input
              type="number"
              min={2}
              max={30}
              value={intervalSeconds}
              onChange={(event) => setIntervalSeconds(event.target.value)}
              className="w-28 rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>
          <button type="button" onClick={saveInterval} disabled={isPending} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-200 disabled:opacity-60">
            Salvar intervalo
          </button>
          <p className="text-xs text-slate-500">Padrão: 4s. Só se aplica com 2 ou mais patrocinadores ativos.</p>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">Ordem de exibição</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => changeOrderMode('random')}
            disabled={isPending}
            className={`rounded-xl border px-4 py-2 text-sm disabled:opacity-60 ${orderMode === 'random' ? 'border-(--brand-500) bg-(--brand-500)/15 text-(--brand-100)' : 'border-slate-800 text-slate-300'}`}
          >
            Aleatória
          </button>
          <button
            type="button"
            onClick={() => changeOrderMode('manual')}
            disabled={isPending}
            className={`rounded-xl border px-4 py-2 text-sm disabled:opacity-60 ${orderMode === 'manual' ? 'border-(--brand-500) bg-(--brand-500)/15 text-(--brand-100)' : 'border-slate-800 text-slate-300'}`}
          >
            Sequência definida
          </button>
        </div>
        <p className="mt-2 text-xs text-slate-500">
          {orderMode === 'random'
            ? 'A ordem dos patrocinadores ativos é embaralhada a cada carregamento da Home e permanece estável durante a sessão.'
            : 'Os patrocinadores ativos aparecem sempre na ordem definida abaixo (menor ordem primeiro). Use as setas na lista para reordenar.'}
        </p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-sm font-semibold text-slate-200">{editingId ? 'Editar patrocinador' : 'Novo patrocinador'}</p>

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Nome</span>
            <input
              value={form.name}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm">
            <span className="text-slate-300">Ordem de exibição</span>
            <input
              type="number"
              value={form.sortOrder}
              onChange={(event) => setForm((prev) => ({ ...prev, sortOrder: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
          </label>

          <label className="space-y-1 text-sm md:col-span-2">
            <span className="text-slate-300">Link de destino do banner</span>
            <input
              type="url"
              placeholder="https://exemplo.com.br"
              value={form.linkUrl}
              onChange={(event) => setForm((prev) => ({ ...prev, linkUrl: event.target.value }))}
              className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2"
            />
            <span className="block text-xs text-slate-500">Opcional. Ao clicar no banner, o usuário será direcionado para este endereço.</span>
          </label>
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
          />
          Patrocinador ativo (visível na Home dos usuários)
        </label>

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={submitForm} disabled={isPending} className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 disabled:opacity-60">
            {isPending ? 'Salvando...' : editingId ? 'Atualizar patrocinador' : 'Criar patrocinador'}
          </button>
          {editingId ? (
            <button type="button" onClick={resetForm} className="rounded-xl border border-slate-700 px-4 py-2 text-sm text-slate-300">
              Novo patrocinador
            </button>
          ) : null}
        </div>

        {editingSponsor ? (
          <div className="mt-5 grid gap-4 border-t border-slate-800 pt-4 md:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-slate-200">Banner</p>
              <div className="mt-2">
                <SponsorBannerUpload sponsorId={editingSponsor.sponsor_id} value={editingSponsor.banner_url} onChange={onBannerChange} />
              </div>
            </div>

            <div>
              <p className="text-sm font-semibold text-slate-200">Usuário vinculado</p>
              {editingSponsor.user_id ? (
                <div className="mt-2 flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-sm text-slate-200">
                  <div>
                    <p>{editingSponsor.user_full_name ?? 'Conta vinculada'}</p>
                    {editingSponsor.user_email ? <p className="text-xs text-slate-400">{editingSponsor.user_email}</p> : null}
                  </div>
                  <button type="button" onClick={unlinkUser} disabled={isPending} className="text-xs text-slate-400 underline">Desvincular</button>
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  <div className="flex gap-2">
                    <input
                      value={candidateTerm}
                      onChange={(event) => setCandidateTerm(event.target.value)}
                      placeholder="Buscar por nome ou e-mail"
                      className="w-full rounded-xl border border-slate-800 bg-slate-950/70 px-3 py-2 text-sm"
                    />
                    <button type="button" onClick={searchCandidates} disabled={isPending} className="shrink-0 rounded-xl border border-slate-700 px-3 py-2 text-xs text-slate-200">
                      Buscar
                    </button>
                  </div>
                  {candidates.length > 0 ? (
                    <div className="space-y-1.5">
                      {candidates.map((candidate) => (
                        <button
                          key={candidate.user_id}
                          type="button"
                          onClick={() => linkUser(candidate)}
                          className="flex w-full items-center justify-between rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-left text-xs text-slate-200 hover:border-slate-600"
                        >
                          <span>{candidate.full_name}</span>
                          <span className="text-slate-400">{candidate.masked_email}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="mt-4 text-xs text-slate-500">Salve o patrocinador para poder enviar o banner e vincular um usuário.</p>
        )}
      </div>

      <div className="space-y-3">
        {sponsors.length === 0 ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-sm text-slate-300">
            Nenhum patrocinador cadastrado. Enquanto não houver nenhum ativo, a área de patrocinadores não aparece na Home.
          </div>
        ) : (
          sponsors.map((sponsor) => (
            <div key={sponsor.sponsor_id} className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
              <div className="flex items-center gap-3">
                {sponsor.banner_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={sponsor.banner_url} alt="" className="h-12 w-20 rounded-lg border border-slate-700 object-cover" />
                ) : null}
                <div>
                  <p className="text-sm font-semibold text-slate-100">{sponsor.name}</p>
                  <p className="text-xs text-slate-400">{sponsor.user_full_name ?? 'Sem usuário vinculado'}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {orderMode === 'manual' && sponsor.is_active ? (
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => moveSponsor(sponsor.sponsor_id, 'up')}
                      disabled={isPending || activeSponsorsInOrder[0]?.sponsor_id === sponsor.sponsor_id}
                      aria-label={`Mover ${sponsor.name} para cima`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 text-slate-300 disabled:opacity-30"
                    >
                      <ArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSponsor(sponsor.sponsor_id, 'down')}
                      disabled={isPending || activeSponsorsInOrder[activeSponsorsInOrder.length - 1]?.sponsor_id === sponsor.sponsor_id}
                      aria-label={`Mover ${sponsor.name} para baixo`}
                      className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700 text-slate-300 disabled:opacity-30"
                    >
                      <ArrowDown size={13} />
                    </button>
                  </div>
                ) : null}
                <span className={`rounded-full border px-3 py-1 text-xs ${sponsor.is_active ? 'border-emerald-500/40 text-emerald-300' : 'border-slate-700 text-slate-400'}`}>
                  {sponsor.is_active ? 'Ativo' : 'Inativo'}
                </span>
                <button type="button" onClick={() => loadForEdit(sponsor)} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">Editar</button>
                <button type="button" onClick={() => toggleActive(sponsor)} disabled={isPending} className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200">
                  {sponsor.is_active ? 'Desativar' : 'Ativar'}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
