import { EmptyAccountState } from '@/components/public/EmptyAccountState';

export default function InscritosPage() {
  return (
    <EmptyAccountState
      title="Pessoas no evento"
      description="Esta tela vai destacar perfis públicos e listas de inscritos conforme a visibilidade de cada conta."
      actionHref="/minha-conta"
      actionLabel="Voltar ao painel"
    />
  );
}
