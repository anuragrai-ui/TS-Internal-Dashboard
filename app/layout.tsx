import type { Metadata } from "next";
import { Inter } from "next/font/google";

import { AppShell } from "@/components/AppShell";

import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata: Metadata = {
  title: "TS Dashboard",
};

const themeInitScript = `
(function () {
  const stored = window.localStorage.getItem("ts-dashboard-theme");
  const meta = document.querySelector('meta[name="color-scheme"]');
  if (stored === "light" || stored === "dark") {
    document.documentElement.dataset.theme = stored;
    if (meta) meta.content = stored;
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.ReactElement {
  return (
    <html className={inter.variable} lang="en" suppressHydrationWarning>
      <head>
        <meta content="light dark" name="color-scheme" />
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={inter.className}>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
