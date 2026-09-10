import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Confirmar primeiro acesso",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true, noarchive: true },
  },
  referrer: "no-referrer",
};

export default function ConfirmFirstAccessLayout({ children }: { children: React.ReactNode }) {
  return children;
}
