import { CheckCircle2, Circle, Clock, XCircle, type LucideIcon } from 'lucide-react';
import { getStatusLabel } from '@/lib/status-labels';

export type StatusChip = { tone: 'success' | 'warning' | 'danger' | 'neutral'; icon: LucideIcon; label: string };

// Fonte unica dos chips de estado operacional -- usada por Meus ingressos e
// Minhas compras pra nunca divergir o que conta como "precisa de atencao"
// (ambar) entre as duas telas. Cor tem significado: verde so quando
// concluido, ambar so quando exige acao real do participante, neutro pro
// resto (nunca tudo virando verde).
export function paymentStatusChip(paymentStatus: string): StatusChip {
  const normalized = paymentStatus.toLowerCase();
  if (normalized === 'confirmed' || normalized === 'paid') {
    return { tone: 'success', icon: CheckCircle2, label: 'Pagamento confirmado' };
  }
  if (normalized === 'pending' || normalized === 'processing' || normalized === 'reserved') {
    return { tone: 'warning', icon: Clock, label: 'Pagamento pendente' };
  }
  if (normalized === 'unavailable' || normalized === 'unknown') {
    return { tone: 'neutral', icon: Circle, label: 'Pagamento indisponível' };
  }
  return { tone: 'danger', icon: XCircle, label: `Pagamento ${getStatusLabel(normalized).toLowerCase()}` };
}

export function kitStatusChip(kitStatus: 'delivered' | 'pending' | null): StatusChip | null {
  if (!kitStatus) return null;
  return kitStatus === 'delivered'
    ? { tone: 'success', icon: CheckCircle2, label: 'Kit entregue' }
    : { tone: 'neutral', icon: Circle, label: 'Kit a retirar' };
}

export function checkinStatusChip(checkinDone: boolean): StatusChip {
  return checkinDone
    ? { tone: 'success', icon: CheckCircle2, label: 'Check-in realizado' }
    : { tone: 'neutral', icon: Circle, label: 'Check-in pendente' };
}
