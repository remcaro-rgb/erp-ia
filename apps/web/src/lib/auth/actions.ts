"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { completeMfa, confirmEnrolment, loginWithPassword, logout, startEnrolment, type Enrolment, type LoginError, type StepResult } from "./login";

// Server actions of the sign-in pages. The sequence lives in ./login (testable without Next); these only read
// the form, hand over Next's cookie store and turn the answer into a redirect.

/** What a form gets back after a failed submit; `nonce` changes every time so the form can reset itself. */
export interface FormState {
  error: LoginError | null;
  nonce: number;
}

const fail = (error: LoginError): FormState => ({ error, nonce: Date.now() });
const text = (form: FormData, name: string) => (typeof form.get(name) === "string" ? (form.get(name) as string) : "");

export async function signIn(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await loginWithPassword(await cookies(), { email: text(form, "email"), password: text(form, "password"), remember: form.get("remember") === "on" });
  if (!result.ok) return fail(result.error);
  redirect(result.next);
}

export async function verifyTotp(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await completeMfa(await cookies(), { code: text(form, "code") });
  if (!result.ok) return fail(result.error);
  redirect(result.next);
}

/** Starts the enrolment and returns the QR and key for the page to show. */
export async function beginEnrolment(): Promise<StepResult<Enrolment>> {
  return startEnrolment(await cookies());
}

export async function finishEnrolment(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await confirmEnrolment(await cookies(), { factorId: text(form, "factorId"), code: text(form, "code") });
  if (!result.ok) return fail(result.error);
  redirect(result.next);
}

export async function signOut(): Promise<void> {
  await logout(await cookies());
  redirect("/login");
}
