// What the sign-in page tells someone who lands on it after something ended their session on purpose (not an error):
// `/login?notice=<code>`, the copy in `auth.notices.<code>`.

export const LOGIN_NOTICES = ["mfa_disabled"] as const;
export type LoginNotice = (typeof LOGIN_NOTICES)[number];

export const isLoginNotice = (value: unknown): value is LoginNotice => typeof value === "string" && (LOGIN_NOTICES as readonly string[]).includes(value);

/**
 * Where the browser goes once the user's second step is gone (design §22.19): the process ended every session of theirs,
 * and the proxy signs out a token that still claims the removed factor.
 */
export const MFA_DISABLED_LOGIN = "/login?notice=mfa_disabled";
