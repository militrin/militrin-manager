export type OrganizationStatus = 'active' | 'trial' | 'suspended' | 'cancelled';

export type Organization = {
  id: string;
  name: string;
  slug: string;
  legal_name: string | null;
  document: string | null;
  email: string | null;
  phone: string | null;
  status: OrganizationStatus;
  plan_code: string | null;
  trial_ends_at: string | null;
  created_at: string;
  updated_at: string;
};

export type OrganizationMember = {
  id: string;
  organization_id: string;
  user_id: string;
  role_id: string | null;
  is_owner: boolean;
  is_active: boolean;
  joined_at: string;
  created_at: string;
  updated_at: string;
};

export type PlatformUserRole = 'owner' | 'admin' | 'support' | 'finance' | 'viewer';

export type PlatformUser = {
  user_id: string;
  role: PlatformUserRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CurrentOrganizationContext = {
  organization: Organization | null;
  /** Organizações ativas do usuário. */
  organizations: Organization[];
  isPlatformUser: boolean;
  isPlatformOwner: boolean;
  isOrgOwner: boolean;
};
