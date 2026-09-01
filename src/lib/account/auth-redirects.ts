import { sanitizePostFirstAccessNextPath } from '@/lib/utils/safe-navigation';
import { appBaseUrl } from '@/lib/urls/app-base-url';

export function firstAccessRouteWithNext(nextPath: string) {
  const safeNext = sanitizePostFirstAccessNextPath(nextPath, '/minha-conta');
  return `/primeiro-acesso?next=${encodeURIComponent(safeNext)}`;
}

export function signupConfirmationRedirect(nextPath = '/minha-conta') {
  return `${appBaseUrl()}/auth/callback?next=${encodeURIComponent(firstAccessRouteWithNext(nextPath))}`;
}
