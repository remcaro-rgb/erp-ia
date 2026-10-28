"use client";

import { useEffect } from "react";
import { useLocale } from "next-intl";

/**
 * Keeps `<html lang>` equal to the request locale. The root layout is static (the locale is request data and
 * cache components keep it out of the prerendered shell), so it ships the default and this corrects it on the client.
 */
export function HtmlLang() {
  const locale = useLocale();
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return null;
}
