export type InstagramOAuthContext = {
  adminUserId: string;
  organizationId: string;
};

export type ExchangedInstagramToken = {
  accessToken: string;
  expiresIn: number | null;
  profile: { id: string; username: string };
};

export type InstagramOAuthStore = {
  createContext(input: {
    state: string;
    adminUserId: string;
    organizationId: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeContext(state: string, now: Date): Promise<InstagramOAuthContext | null>;
  userCanAccessOrganization(userId: string, organizationId: string): Promise<boolean>;
  connectIntegration(input: {
    organizationId: string;
    instagramUserId: string;
    instagramUsername: string;
    encryptedAccessToken: string;
    tokenExpiresAt: string | null;
    actorUserId: string;
  }): Promise<void>;
};
