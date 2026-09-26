"use server";

import { queryOperationsHistory } from "@/lib/operations/history/query";
import type { OperationHistoryQueryInput, OperationHistoryResponse } from "@/lib/operations/history/types";

export async function getOperationsHistoryAction(input: OperationHistoryQueryInput): Promise<OperationHistoryResponse> {
  return queryOperationsHistory(input);
}
