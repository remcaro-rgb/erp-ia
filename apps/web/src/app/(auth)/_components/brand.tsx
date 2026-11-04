import { getTranslations } from "next-intl/server";

export async function Brand() {
  const t = await getTranslations("auth");
  return (
    <div className="flex items-center gap-2">
      {/* The card is white in the light theme and slate in the dark one: the blue wordmark on the first, the white on the second. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- a static wordmark */}
      <img src="/goliatt-logo.png" alt={t("brand")} className="h-8 w-auto dark:hidden" />
      {/* eslint-disable-next-line @next/next/no-img-element -- a static wordmark */}
      <img src="/goliatt-logo-white.png" alt="" aria-hidden className="hidden h-8 w-auto dark:block" />
    </div>
  );
}
