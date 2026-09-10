// Preview dos templates Invite e Magic Link.
// O HTML vivo do Dashboard é lido pela Management API antes de publicar.
// NÃO usar {{ .Type }} — a documentação atual do Supabase não lista essa
// variável. Cada template grava o type explicitamente.

export const LIVE_TEMPLATE_ASSUMPTION = 'ConfirmationURL';

export const INVITE_TEMPLATE_AFTER = `<h2>Convite Militrin</h2>
<p>Você foi convidado a criar sua conta. Este link vale por 24 horas e só funciona uma vez.</p>
<p><a href="{{ .SiteURL }}/auth/confirmar?token_hash={{ .TokenHash }}&type=invite&next=/primeiro-acesso">Confirmar primeiro acesso</a></p>
`;

export const MAGIC_LINK_TEMPLATE_AFTER = `<h2>Novo link de acesso Militrin</h2>
<p>Use este link para continuar o primeiro acesso. Ele vale por 24 horas e substitui o link anterior.</p>
<p><a href="{{ .SiteURL }}/auth/confirmar?token_hash={{ .TokenHash }}&type=magiclink&next=/primeiro-acesso">Confirmar primeiro acesso</a></p>
`;

// Placeholders até a leitura real do Dashboard. Substituídos no relatório
// de produção pelo HTML exportado.
export const INVITE_TEMPLATE_BEFORE = `<h2>You have been invited</h2>
<p>You have been invited to create a user on {{ .SiteURL }}. Follow this link to accept the invite:</p>
<p><a href="{{ .ConfirmationURL }}">Accept the invite</a></p>
`;

export const MAGIC_LINK_TEMPLATE_BEFORE = `<h2>Magic Link</h2>
<p>Follow this link to login:</p>
<p><a href="{{ .ConfirmationURL }}">Log In</a></p>
`;
