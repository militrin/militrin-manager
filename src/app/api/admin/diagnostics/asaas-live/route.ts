import { NextResponse } from "next/server";
import { isEmailConfirmed } from "@/lib/account/email-confirmation";
import { canAccessAdministrativePanel } from "@/lib/admin/panel-access";
import { runAsaasLivePreflightDiag } from "@/lib/payments/asaas-live-preflight-diag";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(body: unknown, status: number) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

export async function GET() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user || !isEmailConfirmed(user)) {
    return json({ error: "Nao autenticado." }, 401);
  }

  if (!(await canAccessAdministrativePanel())) {
    return json({ error: "Acesso negado." }, 403);
  }

  try {
    const result = await runAsaasLivePreflightDiag();
    return json(result, 200);
  } catch {
    return json({ error: "Falha no diagnostico." }, 500);
  }
}
