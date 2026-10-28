"use client";

import { useFormStatus } from "react-dom";
import { authCopy } from "@/lib/auth/copy";
import type { LoginError } from "@/lib/auth/login";

export const fieldClass =
  "w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-300 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100";

export function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-md bg-slate-900 px-3 py-2.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-60 dark:bg-blue-600 dark:hover:bg-blue-500"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

export function FormError({ error }: { error: LoginError | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {authCopy.errors[error]}
    </p>
  );
}
