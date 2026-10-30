"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { recordHref } from "@erp/kernel/href";
import { subjectAccountsAction, type SubjectGrant } from "@/lib/accounting/subject-actions";

/**
 * The Cuentas tab of a role or a user (contributed by the accounting module): the accounts the subject may view and post in. It draws
 * nothing while the company has no accounting or the caller cannot consult the grants.
 */
export function SubjectAccounts({ kind, subjectId }: { kind: "role" | "user"; subjectId: string }) {
  const t = useTranslations("common.acc_pages.subject");
  const [grants, setGrants] = useState<SubjectGrant[] | null>(null);
  useEffect(() => {
    let live = true;
    void subjectAccountsAction(kind, subjectId).then((r) => live && setGrants(r.ok ? r.grants : null));
    return () => {
      live = false;
    };
  }, [kind, subjectId]);
  if (grants === null) return null;
  return (
    <section className="erp-field" aria-label={t("title")}>
      <h3 className="erp-origin__title">{t("title")}</h3>
      {grants.length === 0 ? (
        <p className="erp-small erp-muted">{t("none")}</p>
      ) : (
        <table aria-label={t("title")}>
          <thead>
            <tr>
              <th>{t("account")}</th>
              <th>{t("view")}</th>
              <th>{t("post")}</th>
            </tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.accountId}>
                <td>
                  <Link className="erp-link erp-link--inline" href={recordHref("accounting.account", g.accountId)}>
                    <span className="erp-mono">{g.accountCode}</span> {g.accountName}
                  </Link>
                </td>
                <td>{g.canView ? t("yes") : t("no")}</td>
                <td>{g.canPost ? t("yes") : t("no")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
