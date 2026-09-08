export const INSTAGRAM_AUTHORIZATION_CODE_GRANT = "authorization_code";

export function buildInstagramAuthorizationCodeForm(input: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}) {
  const form = new FormData();
  form.set("client_id", input.clientId);
  form.set("client_secret", input.clientSecret);
  form.set("grant_type", INSTAGRAM_AUTHORIZATION_CODE_GRANT);
  form.set("redirect_uri", input.redirectUri);
  form.set("code", input.code);
  return form;
}

export function listInstagramAuthorizationCodeFormKeys(form: FormData) {
  return [...form.keys()];
}
