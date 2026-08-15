import { cookies } from 'next/headers';
import { createServerSupabaseClient } from '@/lib/supabase/server';
import type { CurrentOrganizationContext, Organization } from './types';

const ORG_COOKIE = 'nexora_org';

/**
 * Resolve o contexto de organização do usuário autenticado:
 * - identifica as organizações ativas do usuário;
 * - aplica prioridade: cookie salvo → primeira org onde é owner → primeira ativa.
 * Platform owner sem organização selecionada recebe organization: null
 * (o painel da plataforma não exige seleção de org).
 */
export async function getCurrentOrganizationContext(): Promise<CurrentOrganizationContext> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const empty: CurrentOrganizationContext = {
    organization: null,
    organizations: [],
    isPlatformUser: false,
    isPlatformOwner: false,
    isOrgOwner: false,
  };

  if (!user) return empty;

  const [platformUserRes, platformOwnerRes, orgIdsRes] = await Promise.all([
    supabase.rpc('is_platform_user', { p_user_id: user.id }),
    supabase.rpc('is_platform_owner', { p_user_id: user.id }),
    supabase.rpc('user_organization_ids', { p_user_id: user.id }),
  ]);

  const isPlatformUserFlag = Boolean(platformUserRes.data);
  const isPlatformOwnerFlag = Boolean(platformOwnerRes.data);
  const orgIds: string[] = orgIdsRes.data ?? [];

  if (!orgIds.length) {
    return { ...empty, isPlatformUser: isPlatformUserFlag, isPlatformOwner: isPlatformOwnerFlag };
  }

  const { data: orgs } = await supabase
    .from('organizations')
    .select('*')
    .in('id', orgIds)
    .eq('status', 'active')
    .order('name');

  const organizations: Organization[] = (orgs ?? []) as Organization[];

  // Resolve organização ativa por prioridade
  const cookieStore = await cookies();
  const savedSlug = cookieStore.get(ORG_COOKIE)?.value;

  let organization: Organization | null = null;

  if (savedSlug) {
    organization = organizations.find((o) => o.slug === savedSlug) ?? null;
  }

  if (!organization) {
    // Verifica se é owner em alguma organização
    for (const org of organizations) {
      const { data } = await supabase.rpc('is_organization_owner', {
        p_user_id: user.id,
        p_organization_id: org.id,
      });
      if (data) {
        organization = org;
        break;
      }
    }
  }

  if (!organization && organizations.length > 0) {
    organization = organizations[0];
  }

  const isOrgOwner = organization
    ? Boolean(
        (
          await supabase.rpc('is_organization_owner', {
            p_user_id: user.id,
            p_organization_id: organization.id,
          })
        ).data,
      )
    : false;

  return {
    organization,
    organizations,
    isPlatformUser: isPlatformUserFlag,
    isPlatformOwner: isPlatformOwnerFlag,
    isOrgOwner,
  };
}
