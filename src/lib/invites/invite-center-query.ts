export function inviteCenterHref(input: {
  eventId?: string | null;
  importBatchId?: string | null;
  status?: string | null;
  shared?: string | null;
  q?: string | null;
  sort?: string | null;
  page?: string | number | null;
  pageSize?: string | number | null;
}) {
  const params = new URLSearchParams();
  if (input.eventId) params.set('eventId', input.eventId);
  if (input.importBatchId) params.set('import_batch_id', input.importBatchId);
  if (input.status && input.status !== 'all') params.set('status', input.status);
  if (input.shared && input.shared !== 'all') params.set('shared', input.shared);
  if (input.q) params.set('q', input.q);
  if (input.sort && input.sort !== 'attention') params.set('sort', input.sort);
  if (input.page && Number(input.page) > 1) params.set('page', String(input.page));
  if (input.pageSize && Number(input.pageSize) !== 25) params.set('pageSize', String(input.pageSize));
  const query = params.toString();
  return query ? `/convites?${query}` : '/convites';
}
