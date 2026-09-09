import { TicketPdfButton } from './TicketPdfButton';
import { TicketPass } from '@/components/ticket-pass/TicketPass';

type TicketViewerProps = {
  eventName: string;
  participantName?: string;
  status: string;
  categoryName?: string | null;
  eventDate?: string | null;
  eventLocation?: string | null;
  token: string;
  orderNumber?: string | null;
  showPdfButton?: boolean;
};

export function TicketViewer({
  eventName,
  participantName,
  status,
  categoryName,
  eventDate,
  eventLocation,
  token,
  orderNumber,
  showPdfButton = true,
}: TicketViewerProps) {
  return (
    <TicketPass
      eventName={eventName}
      participantName={participantName}
      status={status}
      categoryName={categoryName}
      eventDate={eventDate}
      eventLocation={eventLocation}
      token={token}
      orderNumber={orderNumber}
      actions={
        showPdfButton ? (
          <TicketPdfButton
            eventName={eventName}
            participantName={participantName}
            status={status}
            categoryName={categoryName}
            eventDate={eventDate}
            eventLocation={eventLocation}
            token={token}
            orderNumber={orderNumber}
          />
        ) : null
      }
    />
  );
}
