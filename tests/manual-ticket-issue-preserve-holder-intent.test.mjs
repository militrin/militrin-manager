import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildExistingOperationalTicketWarning,
  holderAlreadyAssignedMessage,
  initialManualTicketIssueIntent,
  intentAfterAcknowledgeExisting,
  intentAfterEmitWithoutHolder,
} from '../src/lib/admin/manual-ticket-issue-intent.ts';

const read = (path) => readFile(new URL(path, import.meta.url), 'utf8');

function resolveIssueGate({ hasHolder, hasOperational, intent }) {
  if (intent == null) return 'cancelled';
  if (intent.assignHolder && hasHolder) return 'holder-decision';
  if (hasOperational && !intent.acknowledgeExisting) return 'existing-confirmation';
  if (intent.assignHolder && hasHolder) return 'holder-blocked';
  return intent.assignHolder ? 'issued-with-holder' : 'issued-without-holder';
}

function issueTicket(tickets, contact, intent) {
  const hasHolder = tickets.some((ticket) => ticket.holder === contact);
  const hasOperational = tickets.length > 0;
  const gate = resolveIssueGate({ hasHolder, hasOperational, intent });
  if (gate !== 'issued-with-holder' && gate !== 'issued-without-holder') {
    return { gate, tickets: tickets.map((ticket) => ({ ...ticket })) };
  }
  return {
    gate,
    tickets: [
      ...tickets.map((ticket) => ({ ...ticket })),
      {
        id: tickets.length + 1,
        holder: intent.assignHolder ? contact : null,
        owner: contact,
        participantId: intent.assignHolder ? contact : null,
      },
    ],
  };
}

test('CASO A: cadastro sem ingresso emite normalmente com titular', () => {
  const result = issueTicket([], 'A', initialManualTicketIssueIntent());
  assert.equal(result.gate, 'issued-with-holder');
  assert.equal(result.tickets.length, 1);
  assert.equal(result.tickets[0].holder, 'A');
  assert.equal(result.tickets[0].owner, 'A');
  assert.equal(result.tickets[0].participantId, 'A');
});

test('CASO B: cadastro ja titular exige escolha sem titular', () => {
  const existing = [{ id: 1, holder: 'A', owner: 'A', participantId: 'A' }];
  const result = issueTicket(existing, 'A', initialManualTicketIssueIntent());
  assert.equal(result.gate, 'holder-decision');
  assert.deepEqual(result.tickets, existing);
  assert.deepEqual(intentAfterEmitWithoutHolder(), { assignHolder: false, acknowledgeExisting: false });
});

test('CASO C: Emitir mesmo assim preserva assignHolder=false e cria sem titular', () => {
  const existing = [{ id: 1, holder: 'A', owner: 'A', participantId: 'A' }];
  const withoutHolder = intentAfterEmitWithoutHolder();
  const confirmation = issueTicket(existing, 'A', withoutHolder);
  assert.equal(confirmation.gate, 'existing-confirmation');
  assert.deepEqual(confirmation.tickets, existing);

  const confirmed = intentAfterAcknowledgeExisting(withoutHolder.assignHolder);
  assert.deepEqual(confirmed, { assignHolder: false, acknowledgeExisting: true });
  const issued = issueTicket(existing, 'A', confirmed);
  assert.equal(issued.gate, 'issued-without-holder');
  assert.equal(issued.tickets.length, 2);
  assert.equal(issued.tickets[1].holder, null);
  assert.equal(issued.tickets[1].participantId, null);
  assert.equal(issued.tickets[1].owner, 'A');
});

test('CASO D: terceiro ingresso segue sem titular apos as confirmacoes', () => {
  const existing = [
    { id: 1, holder: 'A', owner: 'A', participantId: 'A' },
    { id: 2, holder: null, owner: 'A', participantId: null },
  ];
  assert.equal(issueTicket(existing, 'A', initialManualTicketIssueIntent()).gate, 'holder-decision');
  const withoutHolder = intentAfterEmitWithoutHolder();
  assert.equal(issueTicket(existing, 'A', withoutHolder).gate, 'existing-confirmation');
  const issued = issueTicket(existing, 'A', intentAfterAcknowledgeExisting(false));
  assert.equal(issued.gate, 'issued-without-holder');
  assert.equal(issued.tickets.length, 3);
  assert.equal(issued.tickets[2].holder, null);
  assert.equal(issued.tickets[2].owner, 'A');
});

test('CASO E: cancelar qualquer confirmacao nao cria ingresso', () => {
  const existing = [{ id: 1, holder: 'A', owner: 'A', participantId: 'A' }];
  assert.equal(resolveIssueGate({ hasHolder: true, hasOperational: true, intent: null }), 'cancelled');
  assert.deepEqual(issueTicket(existing, 'A', null).tickets, existing);
});

test('CASO F: assignHolder=true continua bloqueado se a pessoa ja e titular', () => {
  const existing = [{ id: 1, holder: 'A', owner: 'A', participantId: 'A' }];
  assert.equal(issueTicket(existing, 'A', initialManualTicketIssueIntent()).gate, 'holder-decision');
  assert.equal(
    issueTicket(existing, 'A', intentAfterAcknowledgeExisting(true)).gate,
    'holder-decision',
  );
});

test('CASO G: ingresso existente permanece intacto na emissao do novo', () => {
  const existing = [{ id: 1, holder: 'A', owner: 'A', participantId: 'A', token: 'qr-1' }];
  const issued = issueTicket(existing, 'A', intentAfterAcknowledgeExisting(false));
  assert.deepEqual(issued.tickets[0], existing[0]);
  assert.equal(issued.tickets[1].id, 2);
  assert.notEqual(issued.tickets[1].token, 'qr-1');
});

test('textos separam titularidade de protecao contra duplicidade', () => {
  assert.equal(holderAlreadyAssignedMessage(), 'Esta pessoa já é titular de outro ingresso neste evento.');
  const warning = buildExistingOperationalTicketWarning('#001988-01');
  assert.match(warning, /proteção contra emissão duplicada acidental/);
  assert.match(warning, /OUTRO ingresso/);
  assert.match(warning, /#001988-01/);
  assert.doesNotMatch(warning, /já é titular/);
  assert.doesNotMatch(warning, /titularidade/);
});

test('formulario e action preservam as flags de forma independente', async () => {
  const [form, actions, rpc] = await Promise.all([
    read('../src/app/ingressos/emitir/issue-ticket-form.tsx'),
    read('../src/app/ingressos/emitir/actions.ts'),
    read('../supabase/migrations/20261108000000_payment_amount_guard_and_idempotency.sql'),
  ]);
  assert.match(form, /intentAfterEmitWithoutHolder\(\)/);
  assert.match(form, /intentAfterAcknowledgeExisting\(result\.assignHolder === true\)/);
  assert.doesNotMatch(form, /submit\(true,\s*true\)/);
  assert.doesNotMatch(form, /submit\(false\)/);
  assert.match(actions, /const assignHolder = input\.assignHolder !== false/);
  assert.match(actions, /const acknowledgeExisting = input\.acknowledgeExisting === true/);
  assert.match(actions, /p_assign_holder: assignHolder/);
  assert.match(actions, /p_acknowledge_existing: acknowledgeExisting/);
  assert.match(actions, /assignHolder,/);
  assert.match(actions, /if \(assignHolder\) \{/);
  assert.match(rpc, /perform public\.assert_ticket_holder_contact_available/);
  assert.match(rpc, /EXISTING_OPERATIONAL_TICKET/);
  const issueFn = rpc.slice(
    rpc.indexOf('create or replace function public.issue_manual_ticket_batch'),
    rpc.lastIndexOf('revoke all on function public.issue_manual_ticket_batch'),
  );
  assert.match(issueFn, /if found and coalesce\(p_acknowledge_existing, false\) is not true then/);
  const holderPath = issueFn.slice(
    issueFn.indexOf('if coalesce(p_assign_holder, true) then'),
    issueFn.indexOf('else'),
  );
  const unassignedLoop = issueFn.slice(issueFn.indexOf('for v_index in v_index..p_quantity loop'));
  assert.match(holderPath, /assert_ticket_holder_contact_available/);
  assert.doesNotMatch(unassignedLoop, /assert_ticket_holder_contact_available/);
  assert.doesNotMatch(unassignedLoop, /update public\.tickets[\s\S]*where id <> v_extra\.ticket_id/);
});
