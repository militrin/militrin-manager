import type { EmailOtpType } from '@supabase/supabase-js';

// Tipos canônicos dos templates Militrin. A documentação do GoTrue NÃO
// lista {{ .Type }} como variável de e-mail; cada template já conhece o
// próprio tipo. `satisfies EmailOtpType` falha o build se a versão
// instalada de @supabase/supabase-js deixar de aceitar invite/magiclink.
export const AUTH_INVITE_EMAIL_OTP_TYPE = 'invite' as const satisfies EmailOtpType;
export const AUTH_MAGIC_LINK_EMAIL_OTP_TYPE = 'magiclink' as const satisfies EmailOtpType;

export const FIRST_ACCESS_EMAIL_OTP_TYPES = [
  AUTH_INVITE_EMAIL_OTP_TYPE,
  AUTH_MAGIC_LINK_EMAIL_OTP_TYPE,
] as const satisfies readonly EmailOtpType[];
