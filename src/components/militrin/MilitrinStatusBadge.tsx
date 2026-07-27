import { MilitrinBadge } from './MilitrinBadge';

type MilitrinStatusBadgeProps = {
  status: string;
  label?: string;
};

function resolveTone(status: string): 'neutral' | 'success' | 'warning' | 'danger' | 'info' {
  const normalized = status.toLowerCase();
  if (['paid', 'confirmed', 'active', 'success'].includes(normalized)) return 'success';
  if (['pending', 'warning', 'reserved'].includes(normalized)) return 'warning';
  if (['expired', 'cancelled', 'canceled', 'refunded', 'danger'].includes(normalized)) return 'danger';
  if (['used', 'info', 'processing'].includes(normalized)) return 'info';
  return 'neutral';
}

export function MilitrinStatusBadge({ status, label }: MilitrinStatusBadgeProps) {
  return <MilitrinBadge tone={resolveTone(status)}>{label ?? status}</MilitrinBadge>;
}
