export default function ProductPickupLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(45,212,191,0.12),_transparent_42%),linear-gradient(180deg,_#020617,_#06111c)] text-slate-100">
      {children}
    </div>
  );
}
