import { cookies } from "next/headers";
import { z } from "zod";

import { getServerEnvironment } from "../env";
import { seal, unseal } from "../security/seal";

export const SESSION_COOKIE_NAME = "sentirev_session";
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60;

const sessionSchema = z.object({
  userId: z.string().min(1),
  githubUserId: z.string().min(1),
  githubLogin: z.string().min(1),
  accessToken: z.string().min(1),
  expiresAt: z.number().int().positive(),
});

export type Session = z.infer<typeof sessionSchema>;

export function createSessionValue(
  input: Omit<Session, "expiresAt"> & { expiresAt?: number },
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): string {
  const session: Session = {
    ...input,
    expiresAt: input.expiresAt ?? now + SESSION_MAX_AGE_SECONDS * 1_000,
  };
  return seal(session, secret);
}

export function readSessionValue(
  value: string | undefined,
  secret = getServerEnvironment().SENTIREV_AUTH_SECRET,
  now = Date.now(),
): Session | null {
  if (!value) {
    return null;
  }

  const parsed = sessionSchema.safeParse(unseal<unknown>(value, secret));
  if (!parsed.success || parsed.data.expiresAt <= now) {
    return null;
  }

  return parsed.data;
}

export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  return readSessionValue(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}

export function setSessionCookie(response: Response, value: string): void {
  if (!("cookies" in response)) {
    throw new Error("Response does not support cookies");
  }

  const responseWithCookies = response as Response & {
    cookies: { set: (name: string, value: string, options: CookieOptions) => void };
  };
  responseWithCookies.cookies.set(SESSION_COOKIE_NAME, value, sessionCookieOptions());
}

export function clearSessionCookie(response: Response): void {
  if (!("cookies" in response)) {
    throw new Error("Response does not support cookies");
  }

  const responseWithCookies = response as Response & {
    cookies: { set: (name: string, value: string, options: CookieOptions) => void };
  };
  responseWithCookies.cookies.set(SESSION_COOKIE_NAME, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
}

export type CookieOptions = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "strict" | "none";
  path: string;
  maxAge?: number;
};

export function sessionCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  };
}
