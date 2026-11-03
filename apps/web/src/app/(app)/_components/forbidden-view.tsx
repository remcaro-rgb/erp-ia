"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTabs } from "@erp/ui";

/**
 * A screen the caller may not open (a menu item the company's rules hide for them, entity types spec §9.2): the card, the way back home,
 * and the open tab titled "Sin acceso". Like the not-found view, the effect runs before the shell's own, so the tab is created with this
 * title; when it already exists (a saved tab) it is retitled. The address stays the one asked for (the proxy rewrites, never redirects).
 */
export function ForbiddenInShell() {
  const t = useTranslations("common.forbidden");
  const pathname = usePathname();
  const open = useTabs((s) => s.open);
  const rename = useTabs((s) => s.rename);
  const title = t("title");
  useEffect(() => {
    open({ title, href: pathname, kind: pathname.startsWith("/r/") ? "record" : "grid" });
    rename(pathname, title);
  }, [open, rename, pathname, title]);
  return (
    <div className="mx-auto w-full max-w-3xl">
      <section role="alert" className="erp-card erp-notfound" aria-labelledby="erp-forbidden-title">
        <h1 id="erp-forbidden-title">{t("title")}</h1>
        <p className="erp-notfound__message">{t("message")}</p>
        <p className="erp-muted erp-small">{t("hint")}</p>
        <Link href="/" className="erp-btn erp-btn--primary">
          {t("home")}
        </Link>
      </section>
    </div>
  );
}
