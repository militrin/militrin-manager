import { MilitrinSection, MilitrinStatusBadge } from "@/components/militrin";
import { getStatusLabel } from "@/lib/status-labels";
import { formatDateTimeBR } from "@/lib/utils/date";

// Generaliza o card verde de QR "individual para retirada" ja usado na
// pagina de item de loja standalone -- reaproveitado tambem pela pagina de
// item "compre junto" (dominio order_items). Cobre os 3 modos de
// pickup_qr_mode:
//   - per_line (ou per_unit com quantity=1): 1 card de QR (`qrCodes` com 1
//     entrada, sem `unitLabel`).
//   - per_unit com quantity>1: N cards de QR, um por unidade, cada um com
//     seu proprio `unitLabel` ("Unidade X de N").
//   - none: `qrCodes` vazio -- so mostra status/historico, com texto
//     explicando que a entrega e confirmada manualmente.
export function ProductQrViewer({
  itemName,
  variantText,
  eventName,
  origin,
  createdAt,
  status,
  deliveredAt,
  qrCodes,
}: {
  itemName: string;
  variantText: string | null;
  eventName: string;
  origin: string;
  createdAt: string;
  status: string;
  deliveredAt: string | null;
  qrCodes: Array<{ unitLabel: string | null; qrImageSrc: string; alt: string }>;
}) {
  return (
    <MilitrinSection
      eyebrow="Item da compra"
      title={itemName}
      description={variantText ?? eventName}
      action={<MilitrinStatusBadge status={status} />}
    >
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-slate-500">Produto</dt><dd>{itemName}</dd></div>
        <div><dt className="text-xs text-slate-500">Variante</dt><dd>{variantText ?? "Sem variante"}</dd></div>
        <div><dt className="text-xs text-slate-500">Evento</dt><dd>{eventName}</dd></div>
        <div><dt className="text-xs text-slate-500">Origem</dt><dd>{origin}</dd></div>
        <div><dt className="text-xs text-slate-500">Data</dt><dd>{formatDateTimeBR(createdAt, ' às ')}</dd></div>
        <div><dt className="text-xs text-slate-500">Status</dt><dd>{getStatusLabel(status)}</dd></div>
      </dl>

      {qrCodes.length > 0 ? (
        <div className="mt-5 space-y-3">
          {qrCodes.map((qr, index) => (
            <div key={qr.unitLabel ?? index} className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
              <p className="text-sm font-semibold text-emerald-100">
                {qr.unitLabel ? `QR de retirada — ${qr.unitLabel}` : "QR Code individual para retirada"}
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.qrImageSrc} alt={qr.alt} className="mx-auto mt-3 w-full max-w-sm rounded-xl bg-white" />
              <p className="mt-2 text-xs text-emerald-100/70">
                {qr.unitLabel ? "Este código identifica somente esta unidade." : "Este código identifica somente este item."}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-2xl border border-slate-800 bg-slate-950/60 p-4 text-center text-sm text-slate-300">
          Este item não possui QR de retirada — a entrega é confirmada diretamente pela organização.
        </div>
      )}

      <div className="mt-5 border-t border-slate-800 pt-4">
        <p className="text-xs uppercase text-slate-500">Histórico</p>
        <p className="mt-2 text-sm">{origin} em {formatDateTimeBR(createdAt, ' às ')}.</p>
        {deliveredAt ? <p className="mt-1 text-sm">Entregue em {formatDateTimeBR(deliveredAt, ' às ')}.</p> : null}
      </div>
    </MilitrinSection>
  );
}
