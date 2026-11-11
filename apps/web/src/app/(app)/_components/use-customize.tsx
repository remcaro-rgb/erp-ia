"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { CustomizeDialog, type CustomizeItem } from "@erp/ui";
import { saveShellPrefAction } from "@/lib/prefs/actions";

/**
 * "Personalizar página de inicio" for an Inicio page (the company-wide one and each module's): the switched-off ids (preference
 * `home_hidden`, shared by every Inicio page), the button and the dialog. A change hides or shows the item at once; the saves go one
 * after the other, and when they settle the page is read again so an item switched back on brings its numbers.
 */
export function useHomeCustomize(initialHidden: string[], catalog: CustomizeItem[]) {
  const t = useTranslations("home.dashboard");
  const router = useRouter();
  const [hidden, setHidden] = useState(initialHidden);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = useCallback(
    (next: string[]) => {
      setHidden(next);
      setFailed(false);
      const savedAt = Date.now();
      chain.current = chain.current.then(async () => {
        try {
          const result = await saveShellPrefAction({ key: "home_hidden", value: next, savedAt });
          if (!result.ok) setFailed(true);
        } catch {
          setFailed(true);
        }
      });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void chain.current.then(() => router.refresh()), 350);
    },
    [router],
  );

  const actions = (
    <>
      <button type="button" className="erp-btn" onClick={() => setOpen(true)} data-testid="customize-open">
        {t("customize")}
      </button>
      <CustomizeDialog open={open} onOpenChange={setOpen} items={catalog} hidden={hidden} onChange={change} error={failed} />
    </>
  );
  return { hidden, actions };
}
