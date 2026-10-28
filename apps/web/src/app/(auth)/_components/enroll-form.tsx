"use client";

import { useActionState, useCallback, useEffect, useRef, useState } from "react";
import { beginEnrolment, finishEnrolment, signOut, type FormState } from "@/lib/auth/actions";
import { useTranslations } from "next-intl";
import type { Enrolment, LoginError } from "@/lib/auth/login";
import { FormError, SubmitButton } from "./form-parts";
import { TotpInput } from "./totp-input";

/** Enrolment of the authenticator app: QR and key from Supabase Auth, then the first code (which also signs in). */
export function EnrollForm() {
  const t = useTranslations("auth");
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [startError, setStartError] = useState<LoginError | null>(null);
  const [state, action] = useActionState<FormState, FormData>(finishEnrolment, { error: null, nonce: 0 });
  const form = useRef<HTMLFormElement>(null);
  const submit = useCallback(() => form.current?.requestSubmit(), []);
  const started = useRef(false);

  useEffect(() => {
    // Once per visit (a second call would create a second unverified factor).
    if (started.current) return;
    started.current = true;
    void beginEnrolment().then((result) => (result.ok ? setEnrolment(result) : setStartError(result.error)));
  }, []);

  return (
    <>
      <div>
        <h1 className="font-bold">{t("enroll.title")}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{t("enroll.hint")}</p>
      </div>
      <FormError error={startError} />
      {!enrolment && !startError && <p className="text-sm text-slate-500">{t("enroll.preparing")}</p>}
      {enrolment && (
        <>
          {/* A data: SVG from Auth: next/image has nothing to optimise. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enrolment.qrCode} alt={t("enroll.qr_alt")} width={176} height={176} className="mx-auto rounded bg-white p-2" />
          <p className="text-center text-xs text-slate-500">
            {t("enroll.secret_label")}: <code data-testid="totp-secret" className="font-mono break-all select-all">{enrolment.secret}</code>
          </p>
          <p className="text-sm text-slate-500 dark:text-slate-400">{t("enroll.code_hint")}</p>
          <form ref={form} action={action} className="flex flex-col gap-3">
            <FormError error={state.error} />
            <input type="hidden" name="factorId" value={enrolment.factorId} />
            <TotpInput key={state.nonce} onComplete={submit} />
            <SubmitButton label={t("verify.submit")} pendingLabel={t("verify.submitting")} />
          </form>
        </>
      )}
      <form action={signOut}>
        <button type="submit" className="text-sm text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
          {t("verify.back")}
        </button>
      </form>
    </>
  );
}
