import type { ImportDataIssue } from './import-row-validation.ts';
import { classifyImportedCpf, type CpfCellKind } from './cpf-excel.ts';

export type ExistingPurchaseMatch = {
  importBatchRowId: string;
  sourceFileHash: string;
  occurrenceIndex: number;
  externalPurchaseKey?: string | null;
};

export type IdentityCandidateRef = {
  registration_contact_id: string;
  full_name?: string;
  cpf?: string | null;
  email?: string | null;
  reason: string;
};

export type CurrentEventPurchaseClassification = {
  status: 'ready' | 'data_pending' | 'review_required' | 'error';
  resolution: 'pending' | 'create_new' | 'link_existing';
  errorMessage: string | null;
  identityMatchDetails: Record<string, unknown>;
  identityIssues: ImportDataIssue[];
  additionalPurchase: boolean;
  possibleReimportOfRowId: string | null;
};

function identityIssue(
  issueType: 'missing_required_identity' | 'invalid_identity' | 'excel_leading_zero',
  message: string,
): ImportDataIssue {
  return {
    field_code: 'cpf',
    issue_type: issueType,
    message,
    resolution_scope: 'user_resolvable',
    blocks_payment: false,
    blocks_ticket_issuance: false,
    blocks_checkin: false,
    blocks_kit_delivery: false,
  };
}

export function classifyCurrentEventPurchase(input: {
  cpfInput: string | null;
  cpfCellKind?: CpfCellKind;
  email: string | null;
  cpfMatch: IdentityCandidateRef | null;
  emailMatch: IdentityCandidateRef | null;
  nameMatch: IdentityCandidateRef | null;
  sourceFileHash: string;
  occurrenceIndex: number;
  existingSameEventPurchases: ExistingPurchaseMatch[];
  externalPurchaseKey?: string | null;
}): CurrentEventPurchaseClassification {
  const cpf = classifyImportedCpf(input.cpfInput, input.cpfCellKind);
  const identityIssues: ImportDataIssue[] = [];
  const identityMatchDetails: Record<string, unknown> = {
    purchase: {
      occurrence_index: input.occurrenceIndex,
      source_file_hash: input.sourceFileHash,
    },
  };

  if (cpf.kind === 'missing') {
    identityIssues.push(identityIssue('missing_required_identity', 'CPF obrigatorio ausente. Compra preservada com identidade pendente.'));
  } else if (cpf.kind === 'excel_leading_zero') {
    identityIssues.push(identityIssue('excel_leading_zero', 'Possivel zero inicial removido pelo Excel.'));
    identityMatchDetails.excel_cpf = {
      original: cpf.digits,
      suggested: cpf.excelCandidate,
      cell_kind: cpf.cellKind,
    };
    return {
      status: 'review_required',
      resolution: 'pending',
      errorMessage: 'Possivel zero inicial removido pelo Excel. Confirme o CPF antes de tratar como identidade.',
      identityMatchDetails: { ...identityMatchDetails, reason: 'excel_leading_zero' },
      identityIssues,
      additionalPurchase: false,
      possibleReimportOfRowId: null,
    };
  } else if (cpf.kind === 'invalid') {
    identityIssues.push(identityIssue('invalid_identity', 'CPF invalido. Compra preservada com identidade pendente.'));
  }

  const differentFile = input.existingSameEventPurchases.find((match) => match.sourceFileHash !== input.sourceFileHash);
  if (differentFile) {
    return {
      status: 'review_required',
      resolution: 'pending',
      errorMessage: 'Possivel compra ja importada em outro arquivo. Confirme se e uma nova compra ou duplicacao tecnica.',
      identityMatchDetails: {
        ...identityMatchDetails,
        reason: 'possible_reimport',
        previous_import_batch_row_id: differentFile.importBatchRowId,
      },
      identityIssues,
      additionalPurchase: false,
      possibleReimportOfRowId: differentFile.importBatchRowId,
    };
  }

  const cpfContactId = input.cpfMatch?.registration_contact_id || null;
  const emailContactId = input.emailMatch?.registration_contact_id || null;

  if (cpfContactId && emailContactId && cpfContactId !== emailContactId) {
    return {
      status: 'review_required',
      resolution: 'pending',
      errorMessage: 'Conflito de identidade: CPF e e-mail correspondem a cadastros diferentes.',
      identityMatchDetails: {
        ...identityMatchDetails,
        reason: 'strong_identifier_conflict',
        candidates: [input.cpfMatch, input.emailMatch],
      },
      identityIssues,
      additionalPurchase: false,
      possibleReimportOfRowId: null,
    };
  }

  if (input.cpfMatch) {
    identityMatchDetails.reason = input.emailMatch ? 'cpf_and_email_exact' : 'cpf_exact';
    identityMatchDetails.candidates = [input.cpfMatch];
    identityMatchDetails.additional_purchase = true;
    return {
      status: identityIssues.length ? 'data_pending' : 'ready',
      resolution: 'link_existing',
      errorMessage: identityIssues.length ? identityIssues.map((issue) => issue.message).join(' ') : 'Compra adicional da mesma Pessoa.',
      identityMatchDetails,
      identityIssues,
      additionalPurchase: true,
      possibleReimportOfRowId: null,
    };
  }

  if (input.emailMatch) {
    identityMatchDetails.reason = 'shared_email_account_review';
    identityMatchDetails.account_review = 'shared_email';
    identityMatchDetails.candidates = [input.emailMatch];
    return {
      status: identityIssues.length ? 'data_pending' : 'ready',
      resolution: 'create_new',
      errorMessage: identityIssues.length
        ? identityIssues.map((issue) => issue.message).join(' ')
        : 'E-mail compartilhado. Pessoas permanecem separadas; revise a conta proprietaria dos ingressos.',
      identityMatchDetails,
      identityIssues,
      additionalPurchase: false,
      possibleReimportOfRowId: null,
    };
  }

  if (input.nameMatch) {
    return {
      status: 'review_required',
      resolution: 'pending',
      errorMessage: 'Nome semelhante encontrado; nenhum identificador forte confirmou a identidade.',
      identityMatchDetails: {
        ...identityMatchDetails,
        reason: 'name_only_suggestion',
        candidates: [input.nameMatch],
      },
      identityIssues,
      additionalPurchase: false,
      possibleReimportOfRowId: null,
    };
  }

  identityMatchDetails.reason = 'create_new';
  return {
    status: identityIssues.length ? 'data_pending' : 'ready',
    resolution: 'create_new',
    errorMessage: identityIssues.length ? identityIssues.map((issue) => issue.message).join(' ') : null,
    identityMatchDetails,
    identityIssues,
    additionalPurchase: false,
    possibleReimportOfRowId: null,
  };
}

export function classifyIntraFileSharedEmails(rows: Array<{ email: string | null; cpf: string | null; index: number }>) {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.email) continue;
    const list = groups.get(row.email) ?? [];
    list.push(row.index);
    groups.set(row.email, list);
  }
  const shared = new Set<number>();
  for (const indexes of groups.values()) {
    const distinctCpfs = new Set(
      rows.filter((row) => indexes.includes(row.index) && row.cpf).map((row) => String(row.cpf)),
    );
    if (indexes.length > 1 && distinctCpfs.size !== 1) {
      for (const index of indexes) shared.add(index);
    }
  }
  return shared;
}
