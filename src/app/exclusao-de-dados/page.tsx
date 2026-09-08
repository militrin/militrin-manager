import type { Metadata } from 'next';
import Link from 'next/link';
import { PublicLegalShell } from '@/components/public/PublicLegalShell';
import { militrinTokens } from '@/components/militrin/tokens';
import { cx } from '@/components/militrin/utils';
import { DATA_DELETION_PATH, getMilitrinContactEmail, PRIVACY_POLICY_PATH } from '@/lib/public/legal';
import { DataDeletionRequestForm } from './deletion-request-form';

export const metadata: Metadata = {
  title: 'Exclusão de Dados | Militrin',
  description:
    'Solicite a exclusão de dados pessoais tratados pelo Militrin, inclusive informações associadas à integração com Instagram/Meta, quando aplicável.',
  robots: { index: true, follow: true },
  alternates: { canonical: DATA_DELETION_PATH },
};

export default function ExclusaoDeDadosPage() {
  const contactEmail = getMilitrinContactEmail();

  return (
    <PublicLegalShell
      title="Solicitação de Exclusão de Dados"
      intro="Usuários podem solicitar a exclusão de dados pessoais tratados pelo Militrin, quando aplicável. O formulário abaixo registra um pedido para análise — ele não apaga informações automaticamente."
    >
      <section className="space-y-3" aria-labelledby="como-funciona-title">
        <h2 id="como-funciona-title" className="text-lg font-semibold text-white sm:text-xl">
          Como funciona
        </h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>Você pode solicitar a exclusão de dados pessoais quando aplicável.</li>
          <li>
            Determinadas informações podem precisar ser mantidas por obrigação legal, prevenção de fraude, segurança
            ou exercício regular de direitos.
          </li>
          <li>
            Dados associados a integrações com Instagram/Meta também podem ser incluídos na solicitação quando
            aplicável.
          </li>
        </ul>
        <p>
          A{' '}
          <Link
            href={PRIVACY_POLICY_PATH}
            className={cx(
              'font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200',
              militrinTokens.focusRing,
              'rounded-sm',
            )}
          >
            Política de Privacidade
          </Link>{' '}
          descreve as finalidades de tratamento e os direitos do titular.
        </p>
        <p>
          Para dúvidas sobre esta solicitação, entre em contato pelo e-mail{' '}
          <a
            href={`mailto:${contactEmail}`}
            className={cx(
              'font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200',
              militrinTokens.focusRing,
              'rounded-sm',
            )}
          >
            {contactEmail}
          </a>
          .
        </p>
      </section>

      <section className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4 sm:p-5" aria-labelledby="formulario-exclusao-title">
        <h2 id="formulario-exclusao-title" className="text-lg font-semibold text-white">
          Enviar solicitação
        </h2>
        <p className="mt-2 text-sm text-slate-400">
          Preencha com os seus próprios dados. Informar o e-mail de outra pessoa não provoca exclusão da conta ou dos
          registros dela.
        </p>
        <div className="mt-5">
          <DataDeletionRequestForm />
        </div>
      </section>
    </PublicLegalShell>
  );
}
