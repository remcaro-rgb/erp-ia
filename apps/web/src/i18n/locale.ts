import { defaultLocale, locales, type Locale } from "@erp/i18n";

// Which catalogue a request renders in. The only trusted sources are the `x-erp-locale` request header, which
// `proxy.ts` sets from the verified `locale` claim (and deletes from anything a client sent), and the explicit
// `erp.locale` cookie that a server action writes (the choice of a visitor who is not signed in). Nothing else
// (Accept-Language, query strings) picks a locale.

/** `en-US` → `en`, `es-CO` → `es-419`; an exact match wins; anything else is not a locale of ours. */
function supported(value: string | null | undefined): Locale | null {
  if (!value) return null;
  const exact = locales.find((locale) => locale.toLowerCase() === value.toLowerCase());
  if (exact) return exact;
  const language = value.toLowerCase().split("-")[0];
  return language === "en" ? "en" : language === "es" ? "es-419" : null;
}

export function resolveLocale(source: { header?: string | null; cookie?: string | null }): Locale {
  return supported(source.header) ?? supported(source.cookie) ?? defaultLocale;
}
