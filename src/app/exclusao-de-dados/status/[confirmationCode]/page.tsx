import type { Metadata } from "next";
import { PublicLegalShell } from "@/components/public/PublicLegalShell";
import { DATA_DELETION_PATH } from "@/lib/public/legal";
import {
  INSTAGRAM_DATA_DELETION_STATUS_PATH,
  isValidInstagramConfirmationCode,
} from "@/lib/instagram/meta-callbacks";
import { loadInstagramDataDeletionPublicStatus } from "@/lib/instagram/meta-callback-store";

type PageProps = {
  params: Promise<{ confirmationCode: string }>;
};

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { confirmationCode } = await params;
  return {
    title: "Status da exclusão de dados | Militrin",
    robots: { index: false, follow: false },
    alternates: {
      canonical: `${INSTAGRAM_DATA_DELETION_STATUS_PATH}/${encodeURIComponent(confirmationCode)}`,
    },
  };
}

function statusCopy(status: "received" | "credentials_revoked") {
  if (status === "credentials_revoked") {
    return {
      title: "Solicitação processada",
      intro: "As credenciais da integração Instagram foram invalidadas. Sorteios históricos permanecem preservados para auditoria.",
    };
  }
  return {
    title: "Solicitação recebida",
    intro: "Registramos o pedido técnico de exclusão enviado pela Meta. As credenciais da integração Instagram serão invalidadas.",
  };
}

export default async function InstagramDataDeletionStatusPage({ params }: PageProps) {
  const { confirmationCode } = await params;
  const decoded = decodeURIComponent(confirmationCode);
  const requestStatus = isValidInstagramConfirmationCode(decoded)
    ? await loadInstagramDataDeletionPublicStatus(decoded)
    : null;

  if (!requestStatus) {
    return (
      <PublicLegalShell
        title="Solicitação não encontrada"
        intro="Não encontramos um pedido técnico de exclusão com este código. O código pode estar incompleto ou ainda não ter sido emitido."
      >
        <p>
          Se você pediu a exclusão pela Meta, use o link recebido no app. O formulário público continua em{" "}
          <a href={DATA_DELETION_PATH} className="font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2">
            {DATA_DELETION_PATH}
          </a>
          .
        </p>
      </PublicLegalShell>
    );
  }

  const copy = statusCopy(requestStatus.status);
  const receivedAt = new Date(requestStatus.createdAt);

  return (
    <PublicLegalShell title={copy.title} intro={copy.intro}>
      <dl className="space-y-3">
        <div>
          <dt className="text-xs uppercase tracking-[0.14em] text-slate-500">Status</dt>
          <dd className="mt-1 font-medium text-white">
            {requestStatus.status === "credentials_revoked" ? "Credenciais invalidadas" : "Recebida"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-[0.14em] text-slate-500">Registrada em</dt>
          <dd className="mt-1 font-medium text-white">
            {Number.isNaN(receivedAt.getTime()) ? "—" : receivedAt.toLocaleString("pt-BR")}
          </dd>
        </div>
      </dl>
      <p>
        Este comprovante não exibe identificadores da conta Instagram. Ingressos, pedidos, pagamentos e sorteios
        históricos não são apagados por este fluxo.
      </p>
    </PublicLegalShell>
  );
}
