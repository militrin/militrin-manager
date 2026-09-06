import { NextResponse } from "next/server";
import { isEmailConfirmed } from "@/lib/account/email-confirmation";
import { getAdminAccessContext } from "@/lib/admin/access";
import { runAsaasAccountIdentityDiag } from "@/lib/payments/asaas-account-identity-diag";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const access = await getAdminAccessContext();
  if (!access.user || !access.isAdmin || !isEmailConfirmed(access.user)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const result = await runAsaasAccountIdentityDiag();
  return NextResponse.json(result);
}
