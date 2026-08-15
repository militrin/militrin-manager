import { MilitrinSection } from '@/components/militrin';
import { CartPageClient } from './cart-page-client';

export default function StoreCartPage() {
  return (
    <MilitrinSection eyebrow="Loja" title="Carrinho de Compras" description="Revise os itens escolhidos e finalize o pagamento por evento.">
      <CartPageClient />
    </MilitrinSection>
  );
}
