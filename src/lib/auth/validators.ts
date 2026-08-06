import { z } from "zod";

/**
 * Auth form validation and error copy.
 *
 * Everything a form needs to decide "is this input acceptable" and "what do I
 * tell the user" lives here as pure, exported values — never inline in JSX.
 * The pages import `validateX` and `describeAuthError`; they never construct a
 * message string of their own. That is what makes the rules unit-testable
 * without rendering a single component.
 */

/**
 * Length is the only password rule.
 *
 * Composition rules ("must contain a symbol") measurably push people toward
 * `Password1!` — a short password wearing a costume — and toward reuse.
 * Length is the property that actually costs an attacker something.
 */
export const PASSWORD_MIN_LENGTH = 8;

/** The exact strings the forms render. Tests assert against these. */
export const AUTH_MESSAGES = {
  emailRequired: "Enter your email address.",
  emailInvalid: "Enter a valid email address.",
  passwordRequired: "Enter your password.",
  passwordTooShort: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  confirmRequired: "Re-enter the password.",
  passwordMismatch: "Both passwords must match.",
} as const;

// ---------------------------------------------------------------------------
// Field schemas
// ---------------------------------------------------------------------------

const emailField = z
  .string({ error: AUTH_MESSAGES.emailRequired })
  .trim()
  .min(1, { error: AUTH_MESSAGES.emailRequired })
  .pipe(z.email({ error: AUTH_MESSAGES.emailInvalid }));

/**
 * A password being *set*. `min(1)` runs before `min(8)` so an untouched field
 * says "enter a password" rather than lecturing about length.
 */
const newPasswordField = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .min(1, { error: AUTH_MESSAGES.passwordRequired })
  .min(PASSWORD_MIN_LENGTH, { error: AUTH_MESSAGES.passwordTooShort });

/**
 * A password being *presented*. Deliberately not length-checked: the account
 * may predate the rule, and rejecting client-side would tell the user which
 * half of the credential pair was wrong.
 */
const currentPasswordField = z
  .string({ error: AUTH_MESSAGES.passwordRequired })
  .min(1, { error: AUTH_MESSAGES.passwordRequired });

const confirmField = z
  .string({ error: AUTH_MESSAGES.confirmRequired })
  .min(1, { error: AUTH_MESSAGES.confirmRequired });

const matchesPassword = (value: { password: string; confirmPassword: string }) =>
  value.password === value.confirmPassword;

/** Reported on the confirm field — that is the one the user should retype. */
const mismatchIssue = () => ({
  error: AUTH_MESSAGES.passwordMismatch,
  path: ["confirmPassword"],
});

// ---------------------------------------------------------------------------
// Form schemas
// ---------------------------------------------------------------------------

export const signInSchema = z.object({
  email: emailField,
  password: currentPasswordField,
});

export const signUpSchema = z
  .object({
    email: emailField,
    password: newPasswordField,
    confirmPassword: confirmField,
  })
  .refine(matchesPassword, mismatchIssue());

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z
  .object({
    password: newPasswordField,
    confirmPassword: confirmField,
  })
  .refine(matchesPassword, mismatchIssue());

export type SignInInput = z.output<typeof signInSchema>;
export type SignUpInput = z.output<typeof signUpSchema>;
export type ForgotPasswordInput = z.output<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.output<typeof resetPasswordSchema>;

// ---------------------------------------------------------------------------
// Validation results
// ---------------------------------------------------------------------------

/** One message per field — the shape `<Field error>` consumes directly. */
export type FieldErrors<T> = Partial<Record<Extract<keyof T, string>, string>>;

export type ValidationResult<T> =
  | { ok: true; data: T }
  | { ok: false; errors: FieldErrors<T> };

/**
 * Collapse a ZodError to at most one message per field. Zod reports every
 * failed check; a form has room for one line under each control, and the
 * first issue is the most specific thing that went wrong.
 */
export function toFieldErrors<T>(error: z.ZodError): FieldErrors<T> {
  const errors: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string" || key in errors) continue;
    errors[key] = issue.message;
  }
  return errors as FieldErrors<T>;
}

function validatorFor<S extends z.ZodType>(schema: S) {
  return (input: unknown): ValidationResult<z.output<S>> => {
    const result = schema.safeParse(input);
    return result.success
      ? { ok: true, data: result.data }
      : { ok: false, errors: toFieldErrors<z.output<S>>(result.error) };
  };
}

export const validateSignIn = validatorFor(signInSchema);
export const validateSignUp = validatorFor(signUpSchema);
export const validateForgotPassword = validatorFor(forgotPasswordSchema);
export const validateResetPassword = validatorFor(resetPasswordSchema);

// ---------------------------------------------------------------------------
// Supabase auth errors
// ---------------------------------------------------------------------------

/** Structural stand-in for supabase-js `AuthError` — keeps tests dependency-free. */
export interface AuthErrorLike {
  code?: string;
  message?: string;
}

export const AUTH_ERROR_FALLBACK =
  "Something went wrong on our end. Try again in a moment.";

/**
 * Supabase error code → the sentence we show.
 *
 * Only codes with a genuinely better phrasing than Supabase's own are listed;
 * anything else falls through to `error.message`, which is already plain.
 */
export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "That email and password don’t match an account.",
  email_not_confirmed:
    "This account hasn’t been confirmed yet. Open the confirmation link we emailed you, then sign in.",
  user_already_exists:
    "That email is already registered. Sign in instead, or reset the password.",
  email_exists:
    "That email is already registered. Sign in instead, or reset the password.",
  weak_password: `That password is too weak. Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  same_password:
    "That is already your current password. Choose a different one.",
  over_email_send_rate_limit:
    "Too many emails have been sent recently. Wait a minute and try again.",
  over_request_rate_limit: "Too many attempts. Wait a minute and try again.",
  otp_expired:
    "That link has expired. Request a new one and use it within the hour.",
  session_not_found: "Your session has expired. Sign in again.",
};

/**
 * Older supabase-js releases (and some self-hosted GoTrue versions) leave
 * `code` undefined and only populate `message`. Recover the code from the
 * message so the two cases we care most about — bad credentials and an
 * unconfirmed account — never degrade to raw server prose.
 */
const MESSAGE_TO_CODE: ReadonlyArray<readonly [RegExp, string]> = [
  [/invalid login credentials/i, "invalid_credentials"],
  [/email not confirmed/i, "email_not_confirmed"],
  [/user already registered/i, "user_already_exists"],
  [/already been registered/i, "user_already_exists"],
  [/password should be at least/i, "weak_password"],
];

/** Normalised Supabase error code, or `null` when it cannot be determined. */
export function authErrorCode(
  error: AuthErrorLike | null | undefined,
): string | null {
  if (!error) return null;
  if (error.code) return error.code;
  const message = error.message ?? "";
  for (const [pattern, code] of MESSAGE_TO_CODE) {
    if (pattern.test(message)) return code;
  }
  return null;
}

/** The sentence a form shows for a Supabase auth failure. */
export function describeAuthError(
  error: AuthErrorLike | null | undefined,
): string {
  if (!error) return AUTH_ERROR_FALLBACK;
  const code = authErrorCode(error);
  if (code && AUTH_ERROR_MESSAGES[code]) return AUTH_ERROR_MESSAGES[code];
  return error.message?.trim() || AUTH_ERROR_FALLBACK;
}

/** True when sign-in failed only because the address is not confirmed yet. */
export function isEmailNotConfirmed(
  error: AuthErrorLike | null | undefined,
): boolean {
  return authErrorCode(error) === "email_not_confirmed";
}
