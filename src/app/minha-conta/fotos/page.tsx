import { EmptyAccountState } from '@/components/public/EmptyAccountState';

export default function FotosPage() {
  return (
    <EmptyAccountState
      title="Fotos do evento"
      description="Este espaço será usado para álbuns por evento e entrega de fotos marcadas do participante. A estrutura da rota já está pronta para quando os dados entrarem no banco."
      actionHref="/minha-conta"
      actionLabel="Voltar ao painel"
    />
  );
}