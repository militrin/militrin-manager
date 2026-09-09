import Image from 'next/image';
import { LocalQrImage } from '@/components/qr/LocalQrImage';
import { OktoberfestTicketNotice } from '@/components/public/OktoberfestTicketNotice';
import { TICKET_PASS_COPY } from './ticket-pass-format';

const QR_SIZE = 280;

type TicketQRCodeProps = {
  token: string;
  qrDataUrl?: string | null;
  canShow?: boolean;
  unavailableMessage?: string | null;
  anchorId?: string;
};

export function TicketQRCode({ token, qrDataUrl, canShow = true, unavailableMessage, anchorId }: TicketQRCodeProps) {
  const hasQr = Boolean(qrDataUrl) || Boolean(token.trim());

  return (
    <section id={anchorId} className="scroll-mt-24 px-5 pb-2 pt-6 sm:px-6">
      {canShow && hasQr ? (
        <div className="flex flex-col items-center">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-(--brand-300)">
            {TICKET_PASS_COPY.qrPurpose}
          </p>
          <div className="rounded-[1.35rem] bg-(--brand-500) p-[3px]">
            <div className="rounded-[1.2rem] bg-white p-3">
              {qrDataUrl ? (
                <Image
                  src={qrDataUrl}
                  alt={TICKET_PASS_COPY.qrImageAlt}
                  width={QR_SIZE}
                  height={QR_SIZE}
                  unoptimized
                  className="h-[min(72vw,280px)] w-[min(72vw,280px)] bg-white"
                />
              ) : (
                <LocalQrImage
                  value={token}
                  alt={TICKET_PASS_COPY.qrImageAlt}
                  size={QR_SIZE}
                  className="h-[min(72vw,280px)] w-[min(72vw,280px)] bg-white"
                />
              )}
            </div>
          </div>
          <p className="mt-4 max-w-[18rem] text-center text-[10px] font-semibold uppercase leading-relaxed tracking-[0.18em] text-zinc-400">
            {TICKET_PASS_COPY.qrInstructionLine1}
            <br />
            {TICKET_PASS_COPY.qrInstructionLine2}
          </p>
          <OktoberfestTicketNotice variant="compact" className="mt-4 w-full" />
        </div>
      ) : (
        <div className="rounded-2xl border border-amber-500/25 bg-amber-500/8 px-4 py-5 text-center text-sm text-amber-100">
          {canShow
            ? 'Não foi possível gerar o QR Code.'
            : (unavailableMessage ?? 'O QR Code fica disponível assim que o pagamento é confirmado.')}
        </div>
      )}
    </section>
  );
}
