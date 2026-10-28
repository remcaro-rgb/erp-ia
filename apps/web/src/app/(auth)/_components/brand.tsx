import { getTranslations } from "next-intl/server";

export async function Brand() {
  const t = await getTranslations("auth");
  return (
    <div className="flex items-center gap-2">
      <i className="inline-block size-[26px] rounded-[7px] bg-blue-400" aria-hidden />
      <span className="text-lg font-bold">{t("brand")}</span>
    </div>
  );
}
