"use client";

import { useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTabs } from "@erp/ui";

/** The not-found page's card (Spanish copy from the catalogue), with the way back home. */
export function NotFoundCard() {
  const t = useTranslations("common.not_found");
  return (
    <section className="erp-card erp-notfound" aria-labelledby="erp-notfound-title">
      <h1 id="erp-notfound-title">{t("title")}</h1>
      <p className="erp-notfound__message">{t("message")}</p>
      <p className="erp-muted erp-small">{t("hint")}</p>
      <Link href="/" className="erp-btn erp-btn--primary">
        {t("home")}
      </Link>
    </section>
  );
}

/**
 * Inside the shell (a record that does not exist or that the caller's role may not see, design §5.16): the card, and
 * the open tab titled "No encontrado" instead of "Registro". This effect runs before the shell's own (children first),
 * so the tab is created with the right title; when it already exists (opened from a grid) it is retitled.
 */
export function NotFoundInShell() {
  const t = useTranslations("common.not_found");
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
      <NotFoundCard />
    </div>
  );
}
