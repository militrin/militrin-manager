import { redirect } from "next/navigation";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export default async function InscricoesLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/entrar?next=/inscricoes");
  }

  return <>{children}</>;
}
