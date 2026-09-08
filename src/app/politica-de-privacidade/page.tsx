import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { PublicLegalShell } from '@/components/public/PublicLegalShell';
import { militrinTokens } from '@/components/militrin/tokens';
import { cx } from '@/components/militrin/utils';
import {
  DATA_DELETION_PATH,
  getMilitrinContactEmail,
  LEGAL_LAST_UPDATED_LABEL,
  PRIVACY_POLICY_PATH,
} from '@/lib/public/legal';

export const metadata: Metadata = {
  title: 'Política de Privacidade | Militrin',
  description:
    'Saiba como o Militrin coleta, utiliza, armazena e protege dados pessoais de usuários e participantes, inclusive no contexto da integração com Instagram/Meta.',
  robots: { index: true, follow: true },
  alternates: { canonical: PRIVACY_POLICY_PATH },
};

const sections = [
  { id: 'introducao', label: 'Introdução' },
  { id: 'dados-tratados', label: 'Dados que podem ser tratados' },
  { id: 'instagram-meta', label: 'Integração com Instagram/Meta' },
  { id: 'sorteios-instagram', label: 'Sorteios via Instagram' },
  { id: 'finalidades', label: 'Finalidades' },
  { id: 'compartilhamento', label: 'Compartilhamento' },
  { id: 'armazenamento-seguranca', label: 'Armazenamento e segurança' },
  { id: 'retencao', label: 'Retenção' },
  { id: 'direitos', label: 'Direitos do titular' },
  { id: 'exclusao-de-dados', label: 'Exclusão de dados' },
  { id: 'cookies', label: 'Cookies e tecnologias semelhantes' },
  { id: 'servicos-terceiros', label: 'Serviços de terceiros' },
  { id: 'alteracoes', label: 'Alterações nesta política' },
  { id: 'contato', label: 'Contato' },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24">
      <h2 id={`${id}-title`} className="text-lg font-semibold text-white sm:text-xl">
        {title}
      </h2>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

export default function PoliticaDePrivacidadePage() {
  const contactEmail = getMilitrinContactEmail();

  return (
    <PublicLegalShell
      title="Política de Privacidade"
      intro="Esta política descreve, de forma clara, como o Militrin trata informações relacionadas a usuários e participantes. Os dados efetivamente coletados dependem do fluxo utilizado e das permissões concedidas."
    >
      <nav aria-label="Índice desta política" className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Nesta página</p>
        <ol className="mt-3 grid gap-2 sm:grid-cols-2">
          {sections.map((section, index) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className={cx(
                  'inline-flex rounded-sm text-sm text-emerald-200/90 transition hover:text-emerald-100',
                  militrinTokens.focusRing,
                )}
              >
                <span className="mr-2 tabular-nums text-slate-500">{String(index + 1).padStart(2, '0')}</span>
                {section.label}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Section id="introducao" title="1. Introdução">
        <p>
          Esta Política de Privacidade descreve como o Militrin coleta, utiliza, armazena e protege informações
          relacionadas aos usuários e participantes, no contexto da operação de eventos, inscrições, ingressos, kits,
          check-in, suporte e funcionalidades associadas — inclusive, quando habilitadas, integrações com serviços de
          terceiros como Instagram/Meta.
        </p>
        <p>
          O Militrin é o sistema e o site públicos associados ao domínio militrin.com.br, operados no âmbito do Grupo
          Militrin. Esta política aplica-se às páginas e funcionalidades deste site.
        </p>
      </Section>

      <Section id="dados-tratados" title="2. Dados que podem ser tratados">
        <p>
          Dependendo do fluxo utilizado (por exemplo, criação de conta, inscrição em evento, operação de kits e
          check-in, ou uma solicitação enviada pelo próprio usuário), o Militrin poderá tratar, quando aplicável e na
          medida necessária:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>nome;</li>
          <li>CPF;</li>
          <li>data de nascimento;</li>
          <li>gênero;</li>
          <li>e-mail;</li>
          <li>telefone;</li>
          <li>informações relacionadas à inscrição;</li>
          <li>ingressos;</li>
          <li>pedidos;</li>
          <li>itens vinculados ao participante;</li>
          <li>informações necessárias para retirada de kit e check-in;</li>
          <li>registros operacionais e de auditoria;</li>
          <li>informações fornecidas voluntariamente pelo usuário, inclusive em formulários de contato ou de solicitação de direitos.</li>
        </ul>
        <p>
          Nem todos esses dados são coletados em todos os fluxos. O tratamento ocorre conforme a funcionalidade
          efetivamente utilizada e as informações necessárias para executá-la.
        </p>
      </Section>

      <Section id="instagram-meta" title="3. Integração com Instagram/Meta">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-emerald-300">Instagram / Meta</p>
          <p className="mt-2 text-slate-200">
            Quando uma conta autorizada do Instagram é conectada às funcionalidades do Militrin, o sistema poderá
            acessar dados disponibilizados pela API oficial da Meta, de acordo com as permissões concedidas pelo
            responsável pela conta.
          </p>
        </div>
        <p>
          O acesso ocorre por meio das APIs oficiais disponibilizadas pela Meta/Instagram. Não utilizamos scraping nem
          métodos não autorizados. O conjunto de dados visível ao Militrin depende das permissões efetivamente
          autorizadas na conexão.
        </p>
        <p>Dependendo da funcionalidade e das permissões autorizadas, isso poderá incluir:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>informações básicas da conta profissional conectada;</li>
          <li>publicações e mídias da conta conectada;</li>
          <li>identificadores das publicações;</li>
          <li>legendas e informações relacionadas às mídias;</li>
          <li>comentários feitos em publicações;</li>
          <li>nome de usuário associado ao comentário;</li>
          <li>texto do comentário;</li>
          <li>data/hora e identificadores disponibilizados pela API;</li>
          <li>
            outras informações explicitamente autorizadas pelo responsável pela conta, caso uma funcionalidade futura
            realmente as utilize.
          </li>
        </ul>
        <p>
          Tokens, segredos de aplicativo e credenciais da integração permanecem no servidor e não são expostos nestas
          páginas públicas.
        </p>
      </Section>

      <Section id="sorteios-instagram" title="4. Sorteios realizados através do Instagram">
        <p>
          Quando a funcionalidade de sorteios estiver habilitada, o Militrin poderá utilizar dados de comentários de
          uma publicação — obtidos pela API oficial, conforme as permissões concedidas — para apoiar a operação do
          sorteio.
        </p>
        <p>Isso poderá incluir, conforme as regras configuradas:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>importar participantes a partir dos comentários;</li>
          <li>identificar comentários elegíveis;</li>
          <li>verificar regras configuradas para o sorteio;</li>
          <li>evitar registros duplicados quando aplicável;</li>
          <li>realizar seleção aleatória;</li>
          <li>selecionar suplentes;</li>
          <li>registrar o resultado;</li>
          <li>produzir registros e comprovantes de auditoria do sorteio.</li>
        </ul>
        <p>
          Regras que dependam de verificação externa não disponibilizada de forma confiável pela API — por exemplo,
          seguir a conta, curtir a publicação ou compartilhar nos Stories — poderão ser conferidas de outra forma
          quando configuradas, e não devem ser entendidas como verificação automática neste documento.
        </p>
      </Section>

      <Section id="finalidades" title="5. Finalidades do tratamento">
        <p>Os dados poderão ser tratados para finalidades como:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>operação dos eventos;</li>
          <li>gerenciamento de inscrições;</li>
          <li>emissão e gerenciamento de ingressos;</li>
          <li>controle de retirada de kits;</li>
          <li>check-in;</li>
          <li>suporte;</li>
          <li>segurança;</li>
          <li>prevenção de fraude;</li>
          <li>auditoria;</li>
          <li>execução de sorteios e promoções quando utilizados;</li>
          <li>cumprimento de obrigações legais;</li>
          <li>melhoria das funcionalidades.</li>
        </ul>
      </Section>

      <Section id="compartilhamento" title="6. Compartilhamento">
        <p>O Militrin não comercializa dados pessoais.</p>
        <p>
          As informações poderão ser compartilhadas quando necessário para a operação do serviço, por exemplo com:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>prestadores de infraestrutura;</li>
          <li>fornecedores tecnológicos;</li>
          <li>serviços utilizados para operação do sistema;</li>
          <li>autoridades públicas, quando legalmente exigido;</li>
          <li>Meta/Instagram, nos limites necessários à própria integração e às permissões concedidas.</li>
        </ul>
        <p>
          Esses prestadores tratam dados na medida exigida para executar o serviço contratado. Esta política não
          pretende garantir o comportamento de terceiros além do que for razoavelmente exigível na contratação e na
          operação do sistema.
        </p>
      </Section>

      <Section id="armazenamento-seguranca" title="7. Armazenamento e segurança">
        <p>
          São adotadas medidas técnicas e organizacionais razoáveis para proteger os dados contra acesso não
          autorizado, perda, alteração, divulgação indevida e uso inadequado. Isso inclui controles de acesso,
          comunicação criptografada em trânsito quando aplicável, e restrição de credenciais de integrações ao
          ambiente de servidor.
        </p>
        <p>
          Nenhum sistema é integralmente isento de risco. Esta política não alega certificações, selos ou padrões
          específicos além das práticas efetivamente adotadas na operação do Militrin.
        </p>
      </Section>

      <Section id="retencao" title="8. Retenção">
        <p>
          Os dados são mantidos pelo período necessário às finalidades para as quais foram coletados, ao cumprimento
          de obrigações legais, à prevenção de fraude, ao exercício de direitos e à manutenção de registros
          legítimos, inclusive operacionais e de auditoria.
        </p>
        <p>
          Dados provenientes de integrações externas devem ser excluídos ou anonimizados quando deixarem de ser
          necessários, respeitando obrigações legais e necessidades legítimas de auditoria.
        </p>
      </Section>

      <Section id="direitos" title="9. Direitos do titular">
        <p>
          Nos termos da legislação aplicável, em especial a Lei Geral de Proteção de Dados (LGPD), o titular poderá,
          conforme aplicável, solicitar:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>confirmação da existência de tratamento;</li>
          <li>acesso aos dados;</li>
          <li>correção de dados incompletos, inexatos ou desatualizados;</li>
          <li>anonimização, bloqueio ou eliminação, quando cabível;</li>
          <li>informações sobre compartilhamento;</li>
          <li>revogação de consentimento, quando o tratamento se basear nessa hipótese;</li>
          <li>demais direitos previstos na legislação.</li>
        </ul>
        <p>
          O atendimento observará os limites legais, inclusive hipóteses em que a manutenção de determinadas
          informações seja necessária. Este texto é informativo e não constitui aconselhamento jurídico.
        </p>
      </Section>

      <Section id="exclusao-de-dados" title="10. Exclusão de dados">
        <p>
          Há uma página específica para solicitações de exclusão:{' '}
          <Link
            href={DATA_DELETION_PATH}
            className={cx('font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200', militrinTokens.focusRing, 'rounded-sm')}
          >
            Solicitação de Exclusão de Dados
          </Link>
          .
        </p>
        <p>
          Dados provenientes da integração com Instagram também poderão ser objeto de solicitação de exclusão quando
          aplicável. O envio do formulário registra um pedido para análise; não provoca exclusão automática de contas,
          ingressos, pedidos ou registros cuja manutenção seja legalmente ou operacionalmente necessária.
        </p>
      </Section>

      <Section id="cookies" title="11. Cookies e tecnologias semelhantes">
        <p>
          O Militrin utiliza cookies, armazenamento local do navegador e tecnologias semelhantes quando necessário
          para o funcionamento do site. Isso pode incluir, por exemplo, manter uma sessão autenticada, lembrar etapas
          de um fluxo em andamento ou preservar preferências operacionais.
        </p>
        <p>
          Esses mecanismos servem sobretudo à operação técnica do serviço. A desativação de cookies no navegador pode
          impedir o funcionamento de algumas funcionalidades, como o acesso à conta.
        </p>
      </Section>

      <Section id="servicos-terceiros" title="12. Serviços de terceiros">
        <p>
          Determinadas funcionalidades podem depender de serviços externos, que possuem suas próprias políticas e
          termos. O Militrin utiliza, quando a funcionalidade correspondente está habilitada, a plataforma
          Instagram/Meta para a conexão de contas profissionais e o acesso a dados autorizados via API oficial.
        </p>
        <p>
          Recomendamos a leitura das políticas desses provedores. O Militrin não controla o tratamento realizado
          diretamente por eles nas respectivas plataformas.
        </p>
      </Section>

      <Section id="alteracoes" title="13. Alterações nesta política">
        <p>
          Esta política poderá ser atualizada para refletir mudanças nas funcionalidades, na legislação ou nas
          práticas de tratamento. A versão vigente será a publicada nesta página.
        </p>
        <p className="rounded-2xl border border-slate-800 bg-slate-950/60 px-4 py-3 text-slate-200">
          Última atualização: {LEGAL_LAST_UPDATED_LABEL}
        </p>
      </Section>

      <Section id="contato" title="14. Contato">
        <p>
          Para dúvidas sobre esta política ou para exercer direitos relacionados a dados pessoais, entre em contato
          pelo e-mail{' '}
          <a
            href={`mailto:${contactEmail}`}
            className={cx('font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200', militrinTokens.focusRing, 'rounded-sm')}
          >
            {contactEmail}
          </a>
          {' '}ou utilize a{' '}
          <Link
            href={DATA_DELETION_PATH}
            className={cx('font-medium text-emerald-300 underline decoration-emerald-500/40 underline-offset-2 hover:text-emerald-200', militrinTokens.focusRing, 'rounded-sm')}
          >
            página de solicitação de exclusão
          </Link>
          .
        </p>
      </Section>
    </PublicLegalShell>
  );
}
