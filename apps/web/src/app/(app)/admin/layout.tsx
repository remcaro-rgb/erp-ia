import { getTranslations } from "next-intl/server";
import { AdminSections } from "./_components/admin-sections";

// Administración (design §6, prototype v5): one heading and the section bar over every administration screen.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations();
  return (
    <div className="erp-admin" data-testid="admin">
      <h1>{t("common.admin.title")}</h1>
      <AdminSections />
      {children}
    </div>
  );
}
