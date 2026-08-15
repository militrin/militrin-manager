import { EmptyAccountState } from '@/components/public/EmptyAccountState';

export default function RankingPage() {
  return (
    <EmptyAccountState
      title="Ranking"
      description="O ranking público do usuário entra em uma próxima fase do portal."
      actionHref="/minha-conta"
      actionLabel="Voltar ao painel"
    />
  );
}
