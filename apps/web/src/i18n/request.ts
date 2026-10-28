import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { messages } from "@erp/i18n";
import { LOCALE_COOKIE, LOCALE_HEADER } from "./constants";
import { resolveLocale } from "./locale";

// next-intl's per-request configuration (no locale in the URL): the locale is the verified claim the proxy put
// in `x-erp-locale`, else the visitor's explicit `erp.locale` cookie, else es-419 (see ./locale).
export default getRequestConfig(async () => {
  const [requestHeaders, jar] = await Promise.all([headers(), cookies()]);
  const locale = resolveLocale({ header: requestHeaders.get(LOCALE_HEADER), cookie: jar.get(LOCALE_COOKIE)?.value });
  return { locale, messages: messages(locale) };
});
