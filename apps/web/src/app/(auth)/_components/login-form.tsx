"use client";

import { useActionState, useState } from "react";
import { signIn, type FormState } from "@/lib/auth/actions";
import { useTranslations } from "next-intl";
import type { LoginError } from "@/lib/auth/login";
import { fieldClass, FormError, SubmitButton } from "./form-parts";

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      {off ? (
        <>
          <path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A10.9 10.9 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.2 3.2" />
          <path d="M14.1 14.1a3 3 0 1 1-4.2-4.2" />
          <path d="M1 1l22 22" />
        </>
      ) : (
        <>
          <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </svg>
  );
}

/** E-mail + password, the eye toggle and "Recordarme en este dispositivo por 30 días" (prototype step 1). */
export function LoginForm({ defaultEmail, defaultRemember, initialError }: { defaultEmail: string; defaultRemember: boolean; initialError: LoginError | null }) {
  const t = useTranslations("auth");
  const [state, action] = useActionState<FormState, FormData>(signIn, { error: initialError, nonce: 0 });
  const [shown, setShown] = useState(false);

  return (
    <form action={action} className="flex flex-col gap-3">
      <FormError error={state.error} />
      <div className="flex flex-col gap-1">
        <label htmlFor="email" className="text-sm font-medium">
          {t("login.email")}
        </label>
        <input id="email" name="email" type="email" required autoComplete="username" defaultValue={defaultEmail} autoFocus={defaultEmail === ""} className={fieldClass} />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor="password" className="text-sm font-medium">
          {t("login.password")}
        </label>
        <div className="relative flex">
          <input
            id="password"
            name="password"
            type={shown ? "text" : "password"}
            required
            autoComplete="current-password"
            autoFocus={defaultEmail !== ""}
            className={`${fieldClass} pr-10`}
          />
          <button
            type="button"
            aria-label={shown ? t("login.hide_password") : t("login.show_password")}
            aria-pressed={shown}
            onClick={() => setShown((value) => !value)}
            className="absolute top-1/2 right-1 grid h-7 w-8 -translate-y-1/2 place-items-center rounded text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-700 dark:hover:text-slate-100"
          >
            <EyeIcon off={shown} />
          </button>
        </div>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-sm leading-none whitespace-nowrap">
        <input type="checkbox" name="remember" defaultChecked={defaultRemember} className="size-4 accent-blue-700" />
        <span>{t("login.remember")}</span>
      </label>
      <SubmitButton label={t("login.submit")} pendingLabel={t("login.submitting")} />
    </form>
  );
}
