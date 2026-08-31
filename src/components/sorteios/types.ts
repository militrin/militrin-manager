export type ParticipationStatus = "active" | "disqualified";

export type ParticipationEntry = {
  entryNumber: number;
  commentId: string;
  username: string;
  comment: string;
  mentionsCount: number | null;
  mentions: string;
  commentUrl: string;
  chance: string;
  status: ParticipationStatus;
};

export const DISQUALIFICATION_REASONS = [
  { value: "not_following", label: "Não segue @militrinoktober" },
  { value: "not_liked", label: "Não curtiu a publicação" },
  { value: "not_tagged_friends", label: "Não marcou os amigos conforme regulamento" },
  { value: "not_shared_story", label: "Não compartilhou nos Stories" },
  { value: "private_profile", label: "Perfil fechado / impossível verificar" },
  { value: "other", label: "Outro" },
] as const;

export type DisqualificationReason = (typeof DISQUALIFICATION_REASONS)[number]["value"];

export type DisqualificationRecord = {
  id: string;
  commentId: string;
  username: string;
  comment: string;
  reason: DisqualificationReason;
  reasonLabel: string;
  otherDetail?: string;
  disqualifiedAt: string;
};

export type ValidationChecklistState = {
  follows: boolean;
  liked: boolean;
  taggedFriends: boolean;
  sharedStory: boolean;
};

export const EMPTY_CHECKLIST: ValidationChecklistState = {
  follows: false,
  liked: false,
  taggedFriends: false,
  sharedStory: false,
};

export type HistoryEventType =
  | "import"
  | "draw_started"
  | "winner_selected"
  | "disqualified"
  | "redraw_started"
  | "winner_confirmed"
  | "reset";

export type HistoryEvent = {
  id: string;
  timestamp: string;
  type: HistoryEventType;
  message: string;
  detail?: string;
};

export type SorteioStatus = "empty" | "ready" | "drawing" | "awaiting_validation" | "finalized";

export type ConfirmedWinner = {
  commentId: string;
  confirmedAt: string;
};

export type SorteioSession = {
  id: string;
  createdAt: string;
  importedFileName: string | null;
  importedAt: string | null;
  entries: ParticipationEntry[];
  status: SorteioStatus;
  currentWinnerCommentId: string | null;
  currentDrawAt: string | null;
  currentChecklist: ValidationChecklistState;
  disqualifications: DisqualificationRecord[];
  confirmedWinner: ConfirmedWinner | null;
  history: HistoryEvent[];
};

export type ArchivedSession = SorteioSession & { archivedAt: string };

export const PRIZE_NAME = "1 KIT MILITRIN";
export const INSTAGRAM_HANDLE = "@militrinoktober";
export const INSTAGRAM_POST_URL = "https://www.instagram.com/p/Dcb8sKsJ91b/";
export const INSTAGRAM_POST_ID = "Dcb8sKsJ91b";
