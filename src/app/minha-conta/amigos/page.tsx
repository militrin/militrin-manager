import { EmptyAccountState } from '@/components/public/EmptyAccountState';

export default function AmigosPage() {
  return (
    <EmptyAccountState
      title="Amigos e conexões"
      description="Aqui vai a área de solicitações de amizade e conexões entre usuários quando as tabelas de relacionamento estiverem ativas."
      actionHref="/minha-conta"
      actionLabel="Voltar ao painel"
    />
  );
}
