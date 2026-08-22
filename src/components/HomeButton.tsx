import Link from 'next/link';
import { Home } from 'lucide-react';
import { createServerSupabaseClient } from '@/lib/supabase/server';

export async function HomeButton() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const href = user ? '/minha-conta' : '/';

  return (
    <Link
      href={href}
      aria-label="Página inicial"
      title="Página inicial"
      // Logado + mobile: some. A Central do usuário já tem "Início" na
      // navegação inferior e a área administrativa já tem "Painel" no
      // header/drawer/navegação inferior próprios -- manter este botão
      // flutuante ali só sobrepunha o botão "Voltar" do cabeçalho de cada
      // página. Deslogado (páginas públicas/login) e em qualquer tela >= lg
      // (desktop) o comportamento continua exatamente o mesmo de sempre.
      className={`fixed z-50 ${user ? "hidden lg:flex" : "flex"} h-10 w-10 items-center justify-center rounded-full border border-slate-700/80 bg-slate-950/80 text-slate-200 shadow-lg shadow-black/30 backdrop-blur transition hover:border-emerald-400/60 hover:text-emerald-200`}
      style={{ top: "max(0.75rem, calc(var(--safe-top) + 0.5rem))", left: "0.75rem" }}
    >
      <Home size={18} />
    </Link>
  );
}
