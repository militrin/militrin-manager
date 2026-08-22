import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { getBrandTheme } from "@/lib/theme/get-brand-theme";
import { HomeButton } from "@/components/HomeButton";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Militrin Manager",
  description: "Painel administrativo do Militrin Manager",
};

// viewport-fit=cover libera env(safe-area-inset-*) pro CSS (notch/home
// indicator do iPhone) -- sem isso, as barras fixas moveis novas ficariam
// sempre em 0px de inset mesmo em telas com notch.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const brandTheme = await getBrandTheme();

  return (
    <html
      lang="pt-BR"
      data-brand={brandTheme}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <HomeButton />
        {children}
      </body>
    </html>
  );
}
