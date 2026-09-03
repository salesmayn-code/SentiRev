import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

const evidenceDirectory = path.resolve(process.cwd(), "docs/evidence/phase-002");

type Viewport = { width: number; height: number };

const desktop: Viewport = { width: 1440, height: 900 };
const tablet: Viewport = { width: 768, height: 1024 };
const mobile: Viewport = { width: 390, height: 844 };
const narrow: Viewport = { width: 320, height: 844 };

function captureRuntimeErrors(page: Page): string[] {
  const errors: string[] = [];

  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));

  return errors;
}

async function waitForLocalFonts(page: Page): Promise<void> {
  const fonts = await page.evaluate(async () => {
    await Promise.all([
      document.fonts.load('600 28px "Space Grotesk"'),
      document.fonts.load('400 16px "IBM Plex Sans"'),
      document.fonts.load('400 13px "IBM Plex Mono"'),
    ]);
    await document.fonts.ready;

    return {
      status: document.fonts.status,
      families: Array.from(document.fonts).map((font) => ({
        family: font.family,
        status: font.status,
      })),
      checks: {
        display: document.fonts.check('600 28px "Space Grotesk"'),
        body: document.fonts.check('400 16px "IBM Plex Sans"'),
        mono: document.fonts.check('400 13px "IBM Plex Mono"'),
      },
    };
  });

  expect(fonts.status).toBe("loaded");
  expect(fonts.checks).toEqual({ display: true, body: true, mono: true });
  const loadedFamilies = fonts.families
    .filter((font) => font.status === "loaded")
    .map((font) => font.family);
  expect(loadedFamilies).toEqual(
    expect.arrayContaining([
      "Space Grotesk",
      "IBM Plex Sans",
      "IBM Plex Mono",
    ]),
  );
}

async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}

async function expectFirstViewportContent(page: Page): Promise<void> {
  const selectors = [
    "#checks-heading",
    "#data-boundary-heading",
    'a.primary-button[href="/install"]',
    "#finding-heading",
  ];
  const viewportHeight = page.viewportSize()?.height ?? desktop.height;

  for (const selector of selectors) {
    const element = page.locator(selector).first();
    await expect(element).toBeVisible();
    const box = await element.boundingBox();

    expect(box, `${selector} must fit in the first viewport`).not.toBeNull();
    if (box) {
      expect(box.y + box.height, selector).toBeLessThanOrEqual(viewportHeight);
    }
  }
}

async function expectTouchTargets(page: Page): Promise<void> {
  const controls = page.locator(
    ".wordmark, .nav-link, .primary-button, .secondary-button, summary",
  );
  const sizes = await controls.evaluateAll((elements) =>
    elements
      .filter((element) => {
        const style = window.getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          name: element.textContent?.trim() ?? element.tagName,
          width: rect.width,
          height: rect.height,
        };
      }),
  );

  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) {
    expect(size.width, `${size.name} width`).toBeGreaterThanOrEqual(44);
    expect(size.height, `${size.name} height`).toBeGreaterThanOrEqual(44);
  }
}

async function expectNoRuntimeErrors(errors: string[]): Promise<void> {
  expect(errors, "browser console and page errors").toEqual([]);
}

test.describe.configure({ mode: "serial" });

test.describe("Phase 002 representative visual proof", () => {
  test("@visual landing first viewport presents proof, boundary, and install action", async ({ page }) => {
    await page.setViewportSize(desktop);
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await waitForLocalFonts(page);

    await expect(page.getByRole("heading", {
      level: 1,
      name: "A careful second review for every pull request.",
    })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What it checks" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What it sees" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Authorization bypass" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Install GitHub App", exact: true }).first()).toBeVisible();
    await expectFirstViewportContent(page);
    await expectNoPageOverflow(page);

    await page.screenshot({
      path: path.join(evidenceDirectory, "landing-proof-desktop-1440x900.png"),
      animations: "disabled",
    });
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("landing navigation, semantics, citation, and native disclosure are keyboard usable", async ({ page }) => {
    await page.setViewportSize(desktop);
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await waitForLocalFonts(page);

    await expect(page.locator(".site-header")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Public navigation" })).toBeVisible();
    await expect(page.getByRole("main", { name: "" })).toHaveAttribute("id", "main-content");
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.locator("h2")).toHaveCount(3);

    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await page.keyboard.press("Tab");
    await expect(skipLink).toBeFocused();
    await expect(skipLink).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "SentiRev home" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "How it works" })).toBeFocused();

    await expect(page.getByRole("link", { name: "How it works" })).toHaveAttribute(
      "href",
      "/#how-it-works",
    );
    await expect(page.getByRole("link", { name: "Evals", exact: true })).toHaveAttribute(
      "href",
      "/evals",
    );
    await expect(page.getByRole("link", { name: "Install GitHub App", exact: true }).first()).toHaveAttribute(
      "href",
      "/install",
    );

    const sourceLink = page.locator(
      'a[href^="https://github.com/salesmayn-code/sentirev-test-repo/blob/"]',
    );
    await expect(sourceLink).toHaveText("src/api/admin/export-report.ts:24");
    await expect(page.getByText("salesmayn-code/sentirev-test-repo / PR #2")).toBeVisible();
    await expect(page.getByText("Commit 3f17c37f7c9ef55bf4dc10231da9cdb6e4857868")).toBeVisible();
    await expect(page.locator(".phase-002-code-line-cited code")).toHaveText(
      "return buildAdminReport(user.id);",
    );
    await expect(page.getByRole("complementary", { name: "Representative proof disclosure" })).toContainText(
      "manually prepared representative proof",
    );
    await expect(page.getByRole("complementary", { name: "Representative proof disclosure" })).toContainText(
      "not produced by the current SentiRev pipeline",
    );

    const details = page.locator("details.phase-002-reasoning");
    const summary = details.locator("summary");
    await expect(summary).toHaveText("Show reasoning");
    await expect(details).not.toHaveAttribute("open", "");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(details).toHaveAttribute("open", "");
    await expect(details).toContainText("A separate administrator-role check is needed");
    await page.keyboard.press("Space");
    await expect(details).not.toHaveAttribute("open", "");

    await expectTouchTargets(page);
    await expectNoPageOverflow(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("public navigation reaches the honest pending evals page", async ({ page }) => {
    await page.setViewportSize(desktop);
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await waitForLocalFonts(page);
    await page.getByRole("link", { name: "Evals", exact: true }).click();
    await expect(page).toHaveURL(/\/evals\/?$/);
    await waitForLocalFonts(page);

    await expect(page.getByRole("heading", { level: 1, name: "Evaluation results" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("Results pending");
    await expect(page.getByRole("status")).toContainText("Phase 005");
    await expect(page.getByText("No numbers or pass threshold are available on this pre-release page.")).toBeVisible();
    await expect(page.locator("table")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(/\b\d{1,3}(?:\.\d+)?%/);
    await expectTouchTargets(page);
    await expectNoPageOverflow(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("@visual responsive public layouts reflow at tablet, mobile, and 320 CSS pixels", async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);

    for (const viewport of [tablet, mobile, narrow]) {
      await page.setViewportSize(viewport);
      await page.goto("/");
      await waitForLocalFonts(page);

      await expect(page.getByRole("heading", {
        level: 1,
        name: "A careful second review for every pull request.",
      })).toBeVisible();
      await expect(page.getByRole("link", { name: "Install GitHub App", exact: true }).first()).toBeVisible();
      await expectNoPageOverflow(page);

      if (viewport.width === tablet.width) {
        const notes = page.getByRole("complementary", { name: "Review proof notes" });
        await expect(notes).toBeVisible();
        const proof = page.locator(".phase-002-proof-panel");
        const noteBox = await notes.boundingBox();
        const proofBox = await proof.boundingBox();
        expect(noteBox).not.toBeNull();
        expect(proofBox).not.toBeNull();
        if (noteBox && proofBox) {
          expect(noteBox.y).toBeGreaterThanOrEqual(proofBox.y + proofBox.height);
        }
        await page.screenshot({
          path: path.join(evidenceDirectory, "landing-proof-tablet-768x1024.png"),
          animations: "disabled",
        });
      }

      if (viewport.width === mobile.width) {
        await expect(page.locator(".gutter-rail")).toBeVisible();
        await expect(page.getByRole("complementary", { name: "Review proof notes" })).toBeHidden();
        await expectTouchTargets(page);
        await page.screenshot({
          path: path.join(evidenceDirectory, "landing-proof-mobile-390x844.png"),
          animations: "disabled",
        });
      }
    }

    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("@visual evals page remains legible and overflow-safe on desktop and mobile", async ({ page }) => {
    const runtimeErrors = captureRuntimeErrors(page);

    for (const viewport of [desktop, mobile]) {
      await page.setViewportSize(viewport);
      await page.goto("/evals");
      await waitForLocalFonts(page);

      await expect(page.getByRole("heading", { level: 1, name: "Evaluation results" })).toBeVisible();
      await expect(page.getByRole("status")).toContainText("Results pending");
      await expectNoPageOverflow(page);
      await expectTouchTargets(page);

      const filename = viewport.width === desktop.width
        ? "evals-pending-desktop-1440x900.png"
        : "evals-pending-mobile-390x844.png";
      await page.screenshot({
        path: path.join(evidenceDirectory, filename),
        animations: "disabled",
      });
    }

    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("@visual 200 percent zoom and text scaling preserve public reflow", async ({ page }) => {
    await page.setViewportSize(tablet);
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await waitForLocalFonts(page);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "2";
    });
    await expect(page.getByRole("heading", {
      level: 1,
      name: "A careful second review for every pull request.",
    })).toBeVisible();
    await expectNoPageOverflow(page);

    await page.setViewportSize(mobile);
    await page.evaluate(() => {
      document.documentElement.style.zoom = "1";
      document.documentElement.style.fontSize = "200%";
    });
    await expect(page.getByRole("heading", {
      level: 1,
      name: "A careful second review for every pull request.",
    })).toBeVisible();
    await expectNoPageOverflow(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("reduced motion and forced colors preserve visible semantics", async ({ page }) => {
    await page.setViewportSize(mobile);
    const runtimeErrors = captureRuntimeErrors(page);
    await page.emulateMedia({ reducedMotion: "reduce", forcedColors: "active" });

    await page.goto("/");
    await waitForLocalFonts(page);

    const mediaStyles = await page.evaluate(() => {
      const button = document.querySelector(".primary-button");
      const proof = document.querySelector(".phase-002-proof-panel");
      return {
        transitionDuration: button ? getComputedStyle(button).transitionDuration : "missing",
        proofForcedColorAdjust: proof ? getComputedStyle(proof).forcedColorAdjust : "missing",
      };
    });

    expect(mediaStyles.transitionDuration).toMatch(/^(0s|0ms)$/);
    expect(mediaStyles.proofForcedColorAdjust).toBe("auto");
    await expect(page.getByText("High", { exact: true })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Representative proof disclosure" })).toBeVisible();
    await expectNoPageOverflow(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });

  test("code region has an accessible name and owns its horizontal overflow", async ({ page }) => {
    await page.setViewportSize(mobile);
    const runtimeErrors = captureRuntimeErrors(page);

    await page.goto("/");
    await waitForLocalFonts(page);

    const codeRegion = page.locator(".phase-002-code-scroll");
    await expect(codeRegion).toHaveAttribute("role", "region");
    await expect(codeRegion).toHaveAttribute("aria-labelledby", "cited-code-heading");
    await expect(codeRegion).toHaveAttribute("tabindex", "0");
    const codeMetrics = await codeRegion.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      overflowX: getComputedStyle(element).overflowX,
    }));
    expect(codeMetrics.overflowX).toMatch(/auto|scroll/);
    expect(codeMetrics.scrollWidth).toBeGreaterThanOrEqual(codeMetrics.clientWidth);
    await expectNoPageOverflow(page);
    await expectNoRuntimeErrors(runtimeErrors);
  });
});
