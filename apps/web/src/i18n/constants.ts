// Names shared by the proxy and the i18n request config (kept apart from locale.ts so the proxy does not load the catalogues).

/** Request header the proxy sets from the verified `locale` claim; the render reads it. */
export const LOCALE_HEADER = "x-erp-locale";
/** Cookie a server action writes for a visitor who is not signed in and picked a language. */
export const LOCALE_COOKIE = "erp.locale";
