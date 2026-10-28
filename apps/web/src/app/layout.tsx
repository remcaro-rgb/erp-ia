import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import { Suspense } from "react";
import { NextIntlClientProvider } from "next-intl";
import { defaultLocale } from "@erp/i18n";
import { HtmlLang } from "@/i18n/html-lang";
import "./globals.css";

// Fonts of the design (§19a, rule 24): Source Sans 3 for text, JetBrains Mono for ids, codes and timestamps.
const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "ERP-IA",
};

// The locale and its messages come from the request (src/i18n/request.ts), which is request data: the provider
// sits inside Suspense so the shell stays prerenderable (cache components).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // `data-theme` is set before hydration from the user's saved theme (see (app)/layout.tsx).
    <html lang={defaultLocale} className={`${sourceSans.variable} ${jetbrainsMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full flex flex-col">
        <Suspense fallback={null}>
          <NextIntlClientProvider>
            <HtmlLang />
            {children}
          </NextIntlClientProvider>
        </Suspense>
      </body>
    </html>
  );
}
