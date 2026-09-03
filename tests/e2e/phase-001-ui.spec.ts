import path from "node:path";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";

import { SESSION_COOKIE_NAME, createSessionValue } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence/phase-001");
let userId = "";
let sessionValue = "";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const user = await prisma.user.create({
    data: {
      githubUserId: `phase-001-browser-${runId}`,
      login: `phase-001-browser-${runId}`,
    },
  });
  userId = user.id;
  sessionValue = createSessionValue({
    userId,
    githubUserId: user.githubUserId,
    githubLogin: user.login,
    accessToken: "phase-001-browser-token",
  });
});

test.afterAll(async () => {
  if (userId) await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

async function authenticate(context: BrowserContext): Promise<void> {
  const appUrl = new URL(process.env.SENTIREV_APP_URL ?? "http://127.0.0.1:3000");
  await context.addCookies([{
    name: SESSION_COOKIE_NAME,
    value: sessionValue,
    url: appUrl.origin,
    httpOnly: true,
    sameSite: "Lax",
  }]);
}

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  await expect.poll(() =>
    page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
  ).toBe(true);
}

async function waitForFonts(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
}

test.describe("Phase 001 connection and repository shell", () => {
  test("install page explains the data boundary and consent modes", async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);
    await page.goto("/install");

    await expect(
      page.getByRole("heading", { name: "Connect a GitHub repository" }),
    ).toBeVisible();
    await expect(page.getByText("What SentiRev sees now")).toBeVisible();
    await expect(page.getByText("What this phase does not send")).toBeVisible();
    await expect(page.getByRole("radio", { name: /Semgrep plus AI review/ })).toBeChecked();
    await expect(page.getByRole("radio", { name: /Static-only review/ })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue to GitHub" }),
    ).toHaveAttribute("type", "submit");
    await expect(page.locator('form[action="/api/github/install"]')).toBeVisible();
    await expectNoHorizontalOverflow(page);
    expect(runtimeErrors).toEqual([]);
  });

  test("connection error keeps static-only consent and offers retry", async ({ page }) => {
    await page.goto("/install?consentMode=static&error=unavailable");

    await expect(page.locator('.status[role="alert"]')).toContainText("Connection not completed");
    await expect(page.getByRole("radio", { name: /Static-only review/ })).toBeChecked();
    await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
    await expect(page.getByText("No repository was marked as connected.")).toBeVisible();
  });

  test("repository selection exposes loading, error, retry, and actual POST success", async ({
    page,
  }) => {
    let repositoryRequests = 0;
    await page.route("**/api/github/install/repositories?**", async (route) => {
      repositoryRequests += 1;
      if (repositoryRequests === 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await route.fulfill({
          status: 502,
          contentType: "application/json",
          body: JSON.stringify({ error: "repositories_unavailable" }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          repositories: [{
            id: "123",
            name: "sentirev-test-repo",
            fullName: "salesmayn-code/sentirev-test-repo",
            ownerLogin: "salesmayn-code",
          }],
        }),
      });
    });
    await page.route("**/api/github/install/complete", async (route) => {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toMatchObject({
        installationId: "123",
        repositoryIds: ["123"],
        consentMode: "AI_ALLOWED",
      });
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ repositories: [{ id: "internal-repository" }] }),
      });
    });

    await page.goto("/connect?installation_id=123&consentMode=ai");
    await expect(page.locator('[aria-busy="true"]')).toContainText("Loading repositories");
    await expect(page.locator('.status[role="alert"]')).toContainText("Connection needs attention");
    await page.getByRole("button", { name: "Retry repository list" }).click();
    await page.getByRole("checkbox", {
      name: /salesmayn-code\/sentirev-test-repo/,
    }).check();
    await page.getByRole("button", { name: "Connect selected repositories" }).click();
    await expect(page.getByRole("status")).toContainText("1 repository connected");
  });

  test("unauthenticated dashboard denies repository data", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator('.state-region[role="alert"]')).toContainText(
      "Repository admin access required",
    );
    await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toHaveAttribute(
      "href",
      "/api/auth/github",
    );
  });

  test("authenticated dashboard shows the useful zero-repository state", async ({
    context,
    page,
  }) => {
    await authenticate(context);
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Repositories", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "No connected repositories" })).toBeVisible();
    await expect(page.getByText("even before a pull request has been reviewed")).toBeVisible();
    await expect(page.getByRole("link", { name: "Connect a repository" }).first()).toBeVisible();
  });

  test("dashboard becomes the approved desktop-required notice below 1024px", async ({
    context,
    page,
  }) => {
    await authenticate(context);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");

    await expect(
      page.getByRole("heading", { name: "Use a desktop browser for the dashboard" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Return to public site" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Log out" }).last()).toHaveAttribute(
      "href",
      "/api/auth/logout",
    );
    await expect(page.locator(".dashboard-desktop-content")).toBeHidden();
    await expectNoHorizontalOverflow(page);
  });

  test("public flow preserves focus, reduced motion, forced colors, and 200 percent zoom", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });
    await page.goto("/install");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to main content" })).toBeFocused();
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect(page.getByRole("heading", { name: "Connect a GitHub repository" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

test.describe("Phase 001 visual review", () => {
  test("@visual public install at 1440 by 900", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/install");
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, "public-install-desktop-1440x900.png"),
      animations: "disabled",
    });
  });

  test("@visual public install at 390 by 844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/install");
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, "public-install-mobile-390x844.png"),
      animations: "disabled",
    });
  });

  test("@visual dashboard empty at 1440 by 900", async ({ context, page }) => {
    await authenticate(context);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/dashboard");
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, "dashboard-empty-desktop-1440x900.png"),
      animations: "disabled",
    });
  });

  test("@visual dashboard empty at 1024 by 768", async ({ context, page }) => {
    await authenticate(context);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/dashboard");
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, "dashboard-empty-desktop-1024x768.png"),
      animations: "disabled",
    });
  });

  test("@visual dashboard gate at 390 by 844", async ({ context, page }) => {
    await authenticate(context);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/dashboard");
    await waitForFonts(page);
    await page.screenshot({
      path: path.join(evidenceDirectory, "dashboard-mobile-gate-390x844.png"),
      animations: "disabled",
    });
  });
});
