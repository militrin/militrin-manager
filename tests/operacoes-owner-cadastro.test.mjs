import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolveTicketOwnerRegistrationContact } from "../src/lib/registrations/cadastro-listing.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const ORG = "8d650d17-a190-417d-9ea6-a21e86fb9ac5";
const OTHER_ORG = "other-org";

const PILOTO_USER = "b53009f2-a823-4c1d-b18d-0fea6a1eb90d";
const PILOTO_CONTACT = "614ea99c-ef81-427e-99d0-a691d09aae3c";
const ANA_USER = "db21c973-cd3a-4848-86d0-26381f1de134";
const ANA_CONTACT = "091c42ab-6c47-42d0-bf38-6f8d8190dcac";
const EDUARDO_CONTACT = "7de0bdf5-01d1-441b-a988-29d1360ca832";
const FABIANO_USER = "f7663c1e-12a5-4dfa-b291-843055f97846";
const FABIANO_CONTACT = "fc8f6ea8-8445-4a77-bd07-b1ae84395d12";
const ANDERSON_USER = "398f1a7c-3bc6-43d0-8a97-b50f0d91ea7d";
const ANDERSON_CONTACT = "eba2f9bf-bb37-4f2c-92b0-6e9254afb1d6";
const GIAN_CONTACT = "e636a0bc-984a-4e05-be50-f852b6bb0486";
const ADMIN_INTENDED = "af485a22-8c11-48eb-a02d-fa4485853188";

const piloto = { id: PILOTO_CONTACT, organizationId: ORG, userId: PILOTO_USER };
const ana = { id: ANA_CONTACT, organizationId: ORG, userId: ANA_USER };
const eduardo = { id: EDUARDO_CONTACT, organizationId: ORG, userId: null };
const fabiano = { id: FABIANO_CONTACT, organizationId: ORG, userId: FABIANO_USER };
const anderson = { id: ANDERSON_CONTACT, organizationId: ORG, userId: ANDERSON_USER };
const gian = { id: GIAN_CONTACT, organizationId: ORG, userId: null };
const adminIntended = { id: ADMIN_INTENDED, organizationId: ORG, userId: null };
const holderNoise = { id: "holder-only", organizationId: ORG, userId: null };
const otherOrgSameUser = { id: "other-org-piloto", organizationId: OTHER_ORG, userId: PILOTO_USER };

test("#001609 resolve pelo owner_user_id, nao pelo titular coincidente", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: PILOTO_USER,
    intendedOwnerContactId: PILOTO_CONTACT,
    organizationId: ORG,
    contacts: [piloto, holderNoise],
  });
  assert.equal(resolved.ownerRegistrationContactId, PILOTO_CONTACT);
  assert.equal(resolved.ownerRegistrationSource, "owner_user");
});

test("#001708 owner != titular/intended aponta Ana e ignora Eduardo", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: ANA_USER,
    intendedOwnerContactId: EDUARDO_CONTACT,
    organizationId: ORG,
    contacts: [ana, eduardo, holderNoise],
  });
  assert.equal(resolved.ownerRegistrationContactId, ANA_CONTACT);
  assert.equal(resolved.ownerRegistrationSource, "owner_user");
  assert.notEqual(resolved.ownerRegistrationContactId, EDUARDO_CONTACT);
});

test("#002052 titular Alessandro nao transfere propriedade de Fabiano", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: FABIANO_USER,
    intendedOwnerContactId: null,
    organizationId: ORG,
    contacts: [fabiano, { id: "alessandro-textual", organizationId: ORG, userId: null }],
  });
  assert.equal(resolved.ownerRegistrationContactId, FABIANO_CONTACT);
  assert.equal(resolved.ownerRegistrationSource, "owner_user");
});

test("#001882 owner Anderson permanece com titular Giovanna", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: ANDERSON_USER,
    intendedOwnerContactId: ANDERSON_CONTACT,
    organizationId: ORG,
    contacts: [anderson],
  });
  assert.equal(resolved.ownerRegistrationContactId, ANDERSON_CONTACT);
  assert.equal(resolved.ownerRegistrationSource, "owner_user");
});

test("owner null + intended importado valido", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: null,
    intendedOwnerContactId: GIAN_CONTACT,
    organizationId: ORG,
    contacts: [gian],
  });
  assert.equal(resolved.ownerRegistrationContactId, GIAN_CONTACT);
  assert.equal(resolved.ownerRegistrationSource, "intended_owner");
});

test("owner null + intended administrative valido sem user_id", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: null,
    intendedOwnerContactId: ADMIN_INTENDED,
    organizationId: ORG,
    contacts: [adminIntended],
  });
  assert.equal(resolved.ownerRegistrationContactId, ADMIN_INTENDED);
  assert.equal(resolved.ownerRegistrationSource, "intended_owner");
});

test("owner null + intended null nao resolve", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: null,
    intendedOwnerContactId: null,
    organizationId: ORG,
    contacts: [gian, adminIntended],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
  assert.equal(resolved.ownerRegistrationSource, null);
});

test("owner null + intended de outra org nao resolve", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: null,
    intendedOwnerContactId: GIAN_CONTACT,
    organizationId: ORG,
    contacts: [{ ...gian, organizationId: OTHER_ORG }],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
});

test("intended nunca vence owner_user_id presente", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: ANA_USER,
    intendedOwnerContactId: EDUARDO_CONTACT,
    organizationId: ORG,
    contacts: [eduardo],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
  assert.equal(resolved.ownerRegistrationSource, null);
});

test("participant e order_item.registration_contact_id nao definem o botao", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: ANA_USER,
    intendedOwnerContactId: EDUARDO_CONTACT,
    organizationId: ORG,
    contacts: [eduardo, holderNoise],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
});

test("user_id de outra organizacao nao resolve", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: PILOTO_USER,
    intendedOwnerContactId: null,
    organizationId: ORG,
    contacts: [otherOrgSameUser],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
});

test("dois cadastros no mesmo user_id sao ambiguos", () => {
  const resolved = resolveTicketOwnerRegistrationContact({
    ownerUserId: ANA_USER,
    intendedOwnerContactId: EDUARDO_CONTACT,
    organizationId: ORG,
    contacts: [ana, { ...ana, id: "duplicate-ana" }],
  });
  assert.equal(resolved.ownerRegistrationContactId, null);
});

test("Central seleciona owner_user_id e nao usa titular como fonte do botao", async () => {
  const [actions, ui, types, cadastrosLayout] = await Promise.all([
    read("src/app/operacoes/actions.ts"),
    read("src/app/operacoes/components/ExpandedTicketDetails.tsx"),
    read("src/app/operacoes/types.ts"),
    read("src/app/cadastros/layout.tsx"),
  ]);

  const detailSelect = actions.slice(
    actions.indexOf("async function buildTicketDetails"),
    actions.indexOf("export async function getOperationTicketDetailsAction"),
  );

  assert.match(detailSelect, /owner_user_id/);
  assert.match(detailSelect, /intended_owner_contact_id/);
  assert.match(detailSelect, /resolveTicketOwnerRegistrationContact/);
  assert.match(detailSelect, /eq\("user_id", ticketOwnerUserId\)/);
  assert.match(detailSelect, /if \(ownerOrganizationId && ticketOwnerUserId\)/);
  assert.match(detailSelect, /else if \(ownerOrganizationId && ticketIntendedOwnerContactId\)/);
  assert.doesNotMatch(
    detailSelect.slice(detailSelect.indexOf("let ownerCadastroContacts"), detailSelect.indexOf("const ownerCadastro =")),
    /participant_id/,
  );
  assert.match(actions, /getOperationTicketDetailsAction[\s\S]*?assertPermission\("participants\.view"\)/);
  assert.match(cadastrosLayout, /requirePermission\('participants\.view'\)/);

  assert.match(types, /owner_registration_contact_id/);
  assert.match(types, /owner_registration_source/);
  assert.match(types, /can_view_cadastro/);

  assert.match(ui, /Ver cadastro/);
  assert.match(ui, /owner_registration_contact_id/);
  assert.match(ui, /can_view_cadastro && detail\.owner_registration_contact_id/);
  assert.match(ui, /href=\{`\/cadastros\/\$\{detail\.owner_registration_contact_id\}`\}/);
  assert.doesNotMatch(ui, /Titular sem cadastro vinculado/);
  assert.match(ui, /PIN do cadastro/);
  assert.doesNotMatch(ui, /owner_registration_contact_id\}<\/span>/);
});
