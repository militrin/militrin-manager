import { inviteCenterHref } from "@/lib/invites/invite-center-query";

type Option = { id: string; name?: string; label?: string };

export function InviteCenterFilters({
  eventId,
  importBatchId,
  status,
  shared,
  q,
  sort,
  pageSize,
  events,
  importBatches,
}: {
  eventId?: string;
  importBatchId?: string;
  status: string;
  shared: string;
  q: string;
  sort: string;
  pageSize: number;
  events: Option[];
  importBatches: Option[];
}) {
  return (
    <form action="/convites" className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Busca</span>
        <input name="q" defaultValue={q} placeholder="Nome, e-mail, PIN ou ingresso" className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2" />
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Status</span>
        <select name="status" defaultValue={status} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="all">Todos</option>
          <option value="pendentes">Aguardando acesso</option>
          <option value="cadastro_pendente">Cadastro incompleto</option>
          <option value="expirados">Links expirados</option>
          <option value="concluidos">Concluídos</option>
          <option value="falha">Falha</option>
          <option value="admin_action">Ação necessária</option>
          <option value="nao_enviado">Não enviados</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Evento</span>
        <select name="eventId" defaultValue={eventId ?? ""} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="">Todos os eventos</option>
          {events.map((event) => <option key={event.id} value={event.id}>{event.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Lote / importação</span>
        <select name="import_batch_id" defaultValue={importBatchId ?? ""} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="">Todos os lotes</option>
          {importBatches.map((batch) => <option key={batch.id} value={batch.id}>{batch.label ?? batch.name}</option>)}
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">E-mail compartilhado</span>
        <select name="shared" defaultValue={shared} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="all">Todos</option>
          <option value="yes">Sim</option>
          <option value="no">Não</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Ordenação</span>
        <select name="sort" defaultValue={sort} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="attention">Pendências primeiro</option>
          <option value="recent">Mais recentes</option>
          <option value="oldest">Mais antigos</option>
          <option value="expiring">Expiram primeiro</option>
          <option value="name">Nome</option>
        </select>
      </label>
      <label className="grid gap-1">
        <span className="text-xs text-slate-400">Por página</span>
        <select name="pageSize" defaultValue={String(pageSize)} className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2">
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
      <div className="flex items-end gap-2">
        <button className="inline-flex h-10 items-center justify-center rounded-xl border border-emerald-500/40 px-4 text-emerald-200">Filtrar</button>
        <a href={inviteCenterHref({})} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-sm text-slate-300">Limpar</a>
      </div>
    </form>
  );
}
