"use client";

import { useActionState, useCallback, useRef } from "react";
import { signOut, verifyTotp, type FormState } from "@/lib/auth/actions";
import { authCopy } from "@/lib/auth/copy";
import { FormError, SubmitButton } from "./form-parts";
import { TotpInput } from "./totp-input";

/** Second step of a sign-in: the 6-box TOTP code, submitted by itself when the sixth digit lands. */
export function VerifyForm() {
  const [state, action] = useActionState<FormState, FormData>(verifyTotp, { error: null, nonce: 0 });
  const form = useRef<HTMLFormElement>(null);
  const submit = useCallback(() => form.current?.requestSubmit(), []);

  return (
    <>
      <div>
        <h1 className="font-bold">{authCopy.verify.title}</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{authCopy.verify.hint}</p>
      </div>
      <form ref={form} action={action} className="flex flex-col gap-3">
        <FormError error={state.error} />
        <TotpInput key={state.nonce} onComplete={submit} />
        <SubmitButton label={authCopy.verify.submit} pendingLabel={authCopy.verify.submitting} />
      </form>
      <form action={signOut}>
        <button type="submit" className="text-sm text-slate-500 underline hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
          {authCopy.verify.back}
        </button>
      </form>
    </>
  );
}
