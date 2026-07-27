import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getPublicRegistrationSnapshotAction } from '@/app/inscricao/actions';
import { formatDateTimeBR } from '@/lib/utils/date';

function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

function dateTime(value: string | null) {
  if (!value) return '-';
  return formatDateTimeBR(value, ' às ');
}

export default async function MyRegistrationPage({ params }: { params: Promise<{ participantId: string }> }) {
  const { participantId } = await params;
  const result = await getPublicRegistrationSnapshotAction(participantId);

  if (!result.success || !result.snapshot) {
    notFound();
  }

  const snapshot = result.snapshot;

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(16,185,129,0.16),_transparent_35%),linear-gradient(180deg,_#020617,_#0b1220)] px-4 py-6 text-slate-100 sm:px-6">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <header className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-emerald-300">Militrin</p>
          <h1 className="mt-2 text-2xl font-semibold">Minha inscrição</h1>
          <p className="mt-1 text-sm text-slate-300">Acompanhe sua situação de inscrição e pagamento.</p>
        </header>

        <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-lg font-semibold">Dados do participante</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
            <p>
              <strong>Nome:</strong> {snapshot.full_name}
            </p>
            <p>
              <strong>CPF:</strong> {snapshot.masked_cpf}
            </p>
            <p>
              <strong>Evento:</strong> {snapshot.event_name}
            </p>
            <p>
              <strong>Categoria:</strong> {snapshot.category_name || '-'}
            </p>
            <p>
              <strong>Lote:</strong> {snapshot.batch_name || '-'}
            </p>
            <p>
              <strong>Inscrição:</strong> {snapshot.registration_status}
            </p>
            <p>
              <strong>Reserva:</strong> {snapshot.reservation_status}
            </p>
            <p>
              <strong>Expira:</strong> {dateTime(snapshot.reservation_expires_at)}
            </p>
            <p>
              <strong>Camiseta:</strong> {snapshot.shirt_type || '-'} / {snapshot.shirt_size || '-'}
            </p>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-lg font-semibold">Pagamento</h2>
          <div className="mt-3 grid gap-2 text-sm text-slate-200 sm:grid-cols-2">
            <p>
              <strong>Status:</strong> {snapshot.payment.payment_status}
            </p>
            <p>
              <strong>Método:</strong> {snapshot.payment.payment_method || '-'}
            </p>
            <p>
              <strong>Valor:</strong> {money(snapshot.payment.final_amount)}
            </p>
            <p>
              <strong>Desconto:</strong> {money(snapshot.payment.discount_amount)}
            </p>
            <p>
              <strong>Vencimento:</strong> {dateTime(snapshot.payment.expires_at)}
            </p>
            <p>
              <strong>Pago em:</strong> {dateTime(snapshot.payment.paid_at)}
            </p>
          </div>

          {snapshot.payment.pix_code && snapshot.payment.payment_status === 'pending' && (
            <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-950 p-4 text-xs text-slate-300">
              <p className="mb-2 text-sm font-medium text-slate-200">Código PIX:</p>
              <textarea readOnly value={snapshot.payment.pix_code} className="h-24 w-full rounded-xl border border-slate-700 bg-slate-900 p-3" />
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-slate-800/80 bg-slate-900/70 p-5">
          <h2 className="text-lg font-semibold">Kit e check-in</h2>
          <p className="mt-2 text-sm text-slate-300">
            Token público: <strong>{snapshot.qr_token}</strong>
          </p>
          {snapshot.kit_items.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-200">
              {snapshot.kit_items.map((item: { kit_item_id: string; item_name: string; quantity: number; status: string; delivered_at: string | null }) => (
                <li key={item.kit_item_id}>
                  {item.item_name} x{item.quantity} - {item.status}
                  {item.delivered_at ? ` (${dateTime(item.delivered_at)})` : ''}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-slate-300">Nenhum item de kit vinculado.</p>
          )}
        </section>

        <div>
          <Link href="/inscricao" className="inline-flex h-11 items-center justify-center rounded-2xl bg-emerald-500 px-5 text-sm font-semibold text-emerald-950">
            Fazer nova inscrição
          </Link>
        </div>
      </div>
    </main>
  );
}
