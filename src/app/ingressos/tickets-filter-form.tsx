import Link from 'next/link';
import { adminTicketsClearHref, type AdminTicketListFilters } from '@/lib/admin/admin-ticket-filters';

type Option = { id: string; label: string };

const selectClass = 'h-10 rounded-xl border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100';

export function AdminTicketsFilterForm({
  filters,
  events,
  categories,
}: {
  filters: AdminTicketListFilters;
  events: Option[];
  categories: Option[];
}) {
  const clearHref = adminTicketsClearHref(filters);
  return (
    <form className="grid gap-3 md:grid-cols-2 xl:grid-cols-4" action="/ingressos" method="get">
      {filters.userId ? <input type="hidden" name="userId" value={filters.userId} /> : null}
      <input
        type="search"
        name="q"
        defaultValue={filters.q}
        placeholder="Nome, CPF, e-mail, código, pedido ou pulseira"
        className={`${selectClass} xl:col-span-2`}
        aria-label="Buscar ingressos"
      />
      <label className="grid gap-1 text-xs text-slate-400">
        Evento
        <select name="evento" defaultValue={filters.evento} className={selectClass}>
          <option value="">Todos os eventos</option>
          {events.map((event) => (
            <option key={event.id} value={event.id}>{event.label}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Situação
        <select name="situacao" defaultValue={filters.situacao} className={selectClass}>
          <option value="ativos">Ativos</option>
          <option value="anteriores">Anteriores</option>
          <option value="cancelados">Cancelados</option>
          <option value="inativos">Inativos</option>
          <option value="todos">Todos</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Status do ingresso
        <select name="status" defaultValue={filters.status} className={selectClass}>
          <option value="">Todos os status</option>
          <option value="active">Ativo</option>
          <option value="used">Utilizado</option>
          <option value="cancelled">Cancelado</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Categoria
        <select name="categoria" defaultValue={filters.categoria} className={selectClass}>
          <option value="">Todas as categorias</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>{category.label}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Titularidade
        <select name="titularidade" defaultValue={filters.titularidade} className={selectClass}>
          <option value="">Todas</option>
          <option value="com">Com titular</option>
          <option value="sem">Sem titular</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Proprietário/conta
        <select name="conta" defaultValue={filters.conta} className={selectClass}>
          <option value="">Todas</option>
          <option value="com">Com conta vinculada</option>
          <option value="sem">Sem conta vinculada</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Check-in
        <select name="checkin" defaultValue={filters.checkin} className={selectClass}>
          <option value="">Todos</option>
          <option value="feito">Feito</option>
          <option value="pendente">Pendente</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Kit/retirada
        <select name="kit" defaultValue={filters.kit} className={selectClass}>
          <option value="">Todos</option>
          <option value="entregue">Entregue</option>
          <option value="pendente">Pendente</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs text-slate-400">
        Pagamento
        <select name="pagamento" defaultValue={filters.pagamento} className={selectClass}>
          <option value="">Todos</option>
          <option value="pago">Pago</option>
          <option value="pendente">Pendente</option>
          <option value="cancelado">Cancelado/estornado</option>
        </select>
      </label>
      <div className="flex flex-wrap items-end gap-2 md:col-span-2 xl:col-span-4">
        <button type="submit" className="inline-flex h-10 items-center rounded-xl bg-emerald-400 px-4 text-xs font-semibold text-slate-950">
          Aplicar filtros
        </button>
        <Link href={clearHref} className="inline-flex h-10 items-center rounded-xl border border-slate-700 px-4 text-xs font-semibold text-slate-200">
          Limpar filtros
        </Link>
      </div>
    </form>
  );
}
