export type HistoryPeriodPreset = "today" | "yesterday" | "7d" | "30d" | "custom";

export type ShirtDeliveryStatus = "delivered" | "undone" | "redelivered";

export type OperationHistoryCategory =
  | "kit"
  | "checkin"
  | "wristbands"
  | "holders"
  | "tickets"
  | "store";

export type OperationGrouping = "canonical" | "combined" | "legacy" | "single";

export type OperationHistorySource = "audit" | "holder";

export type OperationRawEvent = {
  id: string;
  occurredAt: string;
  action: string;
  source: OperationHistorySource;
  ticketId: string | null;
  participantId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  actorOrigin: string | null;
  reason: string | null;
  entityType: string | null;
  entityId: string | null;
  details: Record<string, unknown>;
  previousParticipantId: string | null;
  nextParticipantId: string | null;
};

export type OperationCounts = {
  kit: boolean;
  checkin: boolean;
  wristband: boolean;
  correction: boolean;
  manualIssue: boolean;
};

export type OperationStateChange = {
  label: string;
  previous: string | null;
  next: string | null;
};

export type OperationTechnicalDetails = {
  grouping: OperationGrouping;
  sourceActions: string[];
  sourceIds: string[];
  ticketId: string | null;
  actorUserId: string | null;
  entityType: string | null;
  entityId: string | null;
};

export type OperationHistoryItem = {
  id: string;
  occurredAt: string;
  title: string;
  category: OperationHistoryCategory;
  grouping: OperationGrouping;
  participantName: string | null;
  ticketCode: string | null;
  orderNumber: string | null;
  operatorName: string;
  shirtLabel: string | null;
  shirtQuantity: number | null;
  deliveryStatus: ShirtDeliveryStatus | null;
  wristbandLabel: string | null;
  reason: string | null;
  contactId: string | null;
  orderId: string | null;
  eventName: string;
  stateChanges: OperationStateChange[];
  counts: OperationCounts;
  actorUserId: string | null;
  ticketId: string | null;
  sourceActions: string[];
  sourceIds: string[];
  entityType: string | null;
  entityId: string | null;
  technical?: OperationTechnicalDetails | null;
};

export type OperationHistoryCards = {
  operations: number;
  kitsDelivered: number;
  checkins: number;
  wristbands: number;
  corrections: number;
  manualIssues: number;
};

export type OperationHistoryOperator = {
  id: string;
  name: string;
};

export type OperationHistoryQueryInput = {
  eventId: string;
  period: HistoryPeriodPreset;
  dateFrom?: string | null;
  dateTo?: string | null;
  category?: OperationHistoryCategory | "all" | null;
  operatorUserId?: string | null;
  search?: string | null;
  shirtType?: string | null;
  shirtSize?: string | null;
  cursor?: string | null;
  pageSize?: number;
  includeTechnical?: boolean;
};

export type OperationHistoryResult = {
  success: true;
  eventId: string;
  eventName: string;
  dateFrom: string;
  dateTo: string;
  period: HistoryPeriodPreset;
  cards: OperationHistoryCards;
  items: OperationHistoryItem[];
  operators: OperationHistoryOperator[];
  shirtCatalog: { types: string[]; sizesByType: Record<string, string[]> };
  shirtDeliverySummary: {
    periodDeliveries: number;
    periodUndos: number;
    currentlyDelivered: number | null;
    unknownSize: number;
  } | null;
  canViewCadastro: boolean;
  canViewTicket: boolean;
  canViewOrder: boolean;
  nextCursor: string | null;
  truncated: boolean;
  generatedAt: string;
  canViewTechnical: boolean;
};

export type OperationHistoryError = {
  success: false;
  message: string;
};

export type OperationHistoryResponse = OperationHistoryResult | OperationHistoryError;
