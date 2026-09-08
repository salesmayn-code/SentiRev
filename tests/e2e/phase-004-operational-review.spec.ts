import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { SESSION_COOKIE_NAME, createSessionValue } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence/phase-004");
const runId = `phase-004-browser-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const appOrigin = process.env.SENTIREV_APP_URL ?? "http://127.0.0.1:3000";
let userId = "";
let sessionValue = "";

function dashboardUrl(): string {
  return new URL("/dashboard", appOrigin).toString();
}

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function authenticate(context: BrowserContext): Promise<void> {
  const appUrl = new URL(appOrigin);
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: sessionValue,
    url: appUrl.origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (
    document.documentElement.scrollWidth <= document.documentElement.clientWidth
  ))).toBe(true);
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  const user = await prisma.user.create({
    data: { githubUserId: runId, login: runId },
  });
  userId = user.id;
  sessionValue = createSessionValue({
    userId,
    githubUserId: user.githubUserId,
    githubLogin: user.login,
    // The authenticated empty-state path makes no GitHub API request. This is
    // deliberately a non-secret local browser-test value.
    accessToken: "phase-004-browser-test-token",
  });
});

test.afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

test("dashboard protects repository data before authentication", async ({ page }) => {
  const errors = captureRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(dashboardUrl());

  await expect(page.getByRole("heading", {
    name: "Repository admin access required",
  })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
    "href",
    "/api/auth/github",
  );
  await expect(page.getByText("No connected repositories")).toHaveCount(0);
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});

test("authenticated empty repository dashboard reaches usable content within two seconds", async ({
  context,
  page,
}) => {
  await authenticate(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  const startedAt = performance.now();
  const response = await page.goto(dashboardUrl(), { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", {
    name: "No connected repositories",
  })).toBeVisible();
  const elapsedMs = performance.now() - startedAt;

  expect(response?.status()).toBe(200);
  // The dashboard's useful empty state is the representative local baseline
  // until an owner-authorized repository can supply live review data.
  expect(elapsedMs).toBeLessThan(2_000);
});

test("@visual authenticated repository directory provides an intentional empty state at supported widths", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const errors = captureRuntimeErrors(page);

  for (const viewport of [
    { width: 1440, height: 900, filename: "dashboard-repository-empty-1440x900.png" },
    { width: 1024, height: 768, filename: "dashboard-minimum-empty-1024x768.png" },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(dashboardUrl());
    await page.evaluate(() => document.fonts.ready);

    await expect(page.getByRole("heading", {
      name: "Repository review",
    })).toBeVisible();
    await expect(page.getByRole("heading", {
      name: "No connected repositories",
    })).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect a repository" }).first()).toBeVisible();
    await expect(page.locator(".dashboard-desktop-content")).toBeVisible();
    await expectNoPageOverflow(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, viewport.filename),
      animations: "disabled",
    });
  }

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
  expect(errors).toEqual([]);
});

test("@visual dashboard uses the approved desktop-required gate below 1024 pixels", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const errors = captureRuntimeErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(dashboardUrl());

  await expect(page.getByRole("heading", {
    name: "Use a desktop browser for the dashboard",
  })).toBeVisible();
  await expect(page.locator(".dashboard-desktop-content")).toBeHidden();
  await expect(page.getByRole("link", { name: "Return to public site" })).toHaveAttribute(
    "href",
    "/",
  );
  await expect(page.getByRole("link", { name: "Log out" }).last()).toHaveAttribute(
    "href",
    "/api/auth/logout",
  );
  await expectNoPageOverflow(page);
  await page.screenshot({
    path: path.join(evidenceDirectory, "dashboard-mobile-gate-390x844.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("desktop dashboard preserves focus and forced-colors semantics", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const errors = captureRuntimeErrors(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
  await page.goto(dashboardUrl());

  const styles = await page.locator(".dashboard-section").first().evaluate((element) => ({
    forcedColorAdjust: getComputedStyle(element).forcedColorAdjust,
  }));
  expect(styles.forcedColorAdjust).toBe("auto");
  await expectNoPageOverflow(page);
  expect(errors).toEqual([]);
});
