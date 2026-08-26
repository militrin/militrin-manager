import { MilitrinBadge } from './MilitrinBadge';
import { getStatusLabel } from '@/lib/status-labels';

type MilitrinStatusBadgeProps = {
  status: string;
  label?: string;
};

// Exportada -- outras telas (ex.: mini calendario de data em Minhas compras)
// reusam exatamente esta mesma leitura de tom pra nunca divergir da cor do
// badge principal de status.
export function resolveStatusTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  const normalized = status.toLowerCase();
  if (['paid', 'confirmed', 'active', 'success'].includes(normalized)) return 'success';
  if (['pending', 'warning', 'reserved'].includes(normalized)) return 'warning';
  if (['expired', 'cancelled', 'canceled', 'refunded', 'danger'].includes(normalized)) return 'danger';
  if (['used', 'info', 'processing'].includes(normalized)) return 'info';
  return 'neutral';
}

export function MilitrinStatusBadge({ status, label }: MilitrinStatusBadgeProps) {
  return <MilitrinBadge tone={resolveStatusTone(status)}>{label ?? getStatusLabel(status)}</MilitrinBadge>;
}
