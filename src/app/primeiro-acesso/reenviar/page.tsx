import { ResendInviteForm } from "./ResendInviteForm";

export default function ResendFirstAccessInvitePage() {
  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <section className="mx-auto max-w-md rounded-3xl border border-slate-800 bg-slate-900 p-6 text-center">
        <h1 className="text-xl font-semibold">Solicitar novo convite</h1>
        <p className="mt-2 text-sm text-slate-300">
          Informe o e-mail para o qual o convite de primeiro acesso foi enviado. Se ainda estiver pendente, enviaremos um novo link.
        </p>
        <ResendInviteForm />
      </section>
    </main>
  );
}
