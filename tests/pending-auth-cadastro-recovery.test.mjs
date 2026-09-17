import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  adminAttentionCopy,
  contactAccountStateView,
  isPendingEmailConfirmationReason,
  mapEligibilityToAccountState,
  usesExistingAuthDelivery,
} from '../src/lib/account/contact-account-state.ts';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const [
  migration,
  resendModule,
  dispatch,
  signupActions,
  cadastroActions,
  cadastroPage,
  cadastroListPage,
  novoPage,
  criarConta,
  emailProvider,
  inviteCenterActions,
  accountCard,
] = await Promise.all([
  read('supabase/migrations/20261101000000_pending_auth_cadastro_recovery.sql'),
  read('src/lib/account/resend-signup-confirmation.ts'),
  read('src/lib/account/first-access-invite-dispatch.ts'),
  read('src/app/inscricao/actions.ts'),
  read('src/app/cadastros/actions.ts'),
  read('src/app/cadastros/[id]/page.tsx'),
  read('src/app/cadastros/page.tsx'),
  read('src/app/cadastros/novo/page.tsx'),
  read('src/app/criar-conta/page.tsx'),
  read('src/lib/email/fake-provider.ts'),
  read('src/app/convites/actions.ts'),
  read('src/app/cadastros/contact-account-card.tsx'),
]);

test('A) signup normal continua pedindo confirmacao GoTrue sem duplicar mailer do app', () => {
  assert.match(signupActions, /supabase\.auth\.signUp\(/);
  assert.match(signupActions, /signupConfirmationRedirect\(postSignupDestination\)/);
  assert.match(signupActions, /Confirmacao de signup: somente GoTrue/);
  assert.doesNotMatch(signupActions, /emailProvider\.sendAccountConfirmation/);
});

test('B) signup publico com Auth pendente nao cria segunda Auth e oferece resend', () => {
  assert.match(signupActions, /find_auth_email_confirmation_status/);
  assert.match(signupActions, /PENDING_EMAIL_CONFIRMATION/);
  assert.match(signupActions, /Já existe uma conta pendente para este e-mail/);
  assert.match(criarConta, /Reenviar confirmação/);
  assert.match(criarConta, /Voltar para entrar/);
  assert.match(criarConta, /resendConfirmationEmailAction/);
});

test('C/D) admin cria/ficha Cadastro com Auth pendente oferece resend e nao usa inviteUserByEmail', () => {
  assert.match(migration, /pending_email_confirmation/);
  assert.match(cadastroPage, /get_registration_contact_account_state/);
  assert.match(cadastroPage, /ContactAccountCard/);
  assert.match(cadastroActions, /resendCadastroSignupConfirmationAction/);
  assert.match(cadastroActions, /isPendingEmailConfirmationReason/);
  assert.match(dispatch, /PENDING_AUTH_REQUIRES_SIGNUP_RESEND/);
  assert.match(novoPage, /pending_confirmation/);
  assert.match(inviteCenterActions, /pending_email_confirmation/);
});

test('E) Auth confirmada existente nao tenta criar duplicata via inviteUserByEmail', () => {
  assert.match(migration, /invite_existing_confirmed_account/);
  assert.match(dispatch, /usesExistingAuthDelivery\(input\.reasonCode\)/);
  assert.equal(usesExistingAuthDelivery('invite_existing_confirmed_account'), true);
  assert.equal(usesExistingAuthDelivery('resend_invite_existing_account'), true);
  assert.equal(usesExistingAuthDelivery('eligible'), false);
});

test('F) conflito incompativel usa mensagem administrativa sem vazar org', () => {
  assert.match(migration, /Esta conta requer tratamento administrativo/);
  assert.equal(adminAttentionCopy('account_attention'), 'Esta conta requer tratamento administrativo.');
  assert.doesNotMatch(migration, /outra organizacao/);
  assert.doesNotMatch(cadastroPage, /from\("auth\.users"\)/);
  assert.doesNotMatch(cadastroListPage, /auth\.users/);
  assert.doesNotMatch(accountCard, /Resolver situação/);
  const attentionBlock = accountCard.slice(accountCard.indexOf('state === "attention"'));
  assert.doesNotMatch(attentionBlock, /<button/);
});

test('G) resend canonico usa GoTrue, redirect seguro e anti-enumeracao publica', () => {
  assert.match(resendModule, /import 'server-only'/);
  assert.match(resendModule, /createServerSupabaseClient/);
  assert.doesNotMatch(resendModule, /createServiceRoleSupabaseClient/);
  assert.match(resendModule, /supabase\.auth\.resend\(\{/);
  assert.match(resendModule, /type: 'signup'/);
  assert.match(resendModule, /signupConfirmationRedirect\(input\.nextPath\)/);
  assert.match(resendModule, /audience: 'public' \| 'admin'/);
  assert.match(resendModule, /Se houver uma conta pendente para este e-mail, enviaremos uma nova confirmação/);
  assert.match(resendModule, /Envio de confirmação solicitado/);
  assert.match(resendModule, /rate_limit/);
  assert.match(migration, /revoke all on function public\.find_auth_email_confirmation_status\(text\)/);
  assert.match(migration, /grant execute on function public\.find_auth_email_confirmation_status\(text\) to service_role/);
  assert.doesNotMatch(migration, /grant execute on function public\.find_auth_email_confirmation_status\(text\) to (anon|authenticated|public)/);
});

test('H) classificacao e UI nao alteram ownership de ingresso', () => {
  assert.doesNotMatch(migration, /update public\.tickets/);
  assert.doesNotMatch(cadastroActions, /owner_user_id/);
  assert.match(migration, /t\.owner_user_id = v_auth\.id/);
  assert.equal(mapEligibilityToAccountState({ reasonCode: 'pending_email_confirmation' }), 'pending_confirmation');
  assert.equal(mapEligibilityToAccountState({ linkedUserId: 'x' }), 'active');
  assert.equal(mapEligibilityToAccountState({ eligible: true, reasonCode: 'eligible' }), 'none');
  assert.equal(mapEligibilityToAccountState({ eligible: true, reasonCode: 'invite_existing_confirmed_account' }), 'existing_confirmed');
  assert.equal(mapEligibilityToAccountState({ reasonCode: 'account_attention' }), 'attention');
  assert.equal(contactAccountStateView('pending_confirmation').label, 'Aguardando confirmação');
  assert.equal(contactAccountStateView('pending_confirmation').canResendConfirmation, true);
  assert.equal(isPendingEmailConfirmationReason('pending_email_confirmation'), true);
});

test('ConsoleEmailProvider nao e tratado como envio real de confirmacao Auth', () => {
  assert.match(emailProvider, /account-confirmation-ignored/);
  assert.match(emailProvider, /GoTrue\/Supabase Auth envia o token/);
});

test('/cadastros nao lista auth.users', () => {
  assert.match(cadastroListPage, /from\("registration_contacts"\)/);
  assert.doesNotMatch(cadastroListPage, /auth\.users/);
  assert.doesNotMatch(cadastroListPage, /from\("users"\)/);
});
