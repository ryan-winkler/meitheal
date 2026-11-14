import { test, expect } from "@playwright/test";
import { shouldSkipBrowserSpecs } from "./_helpers";

test.describe("Responsive Navigation", () => {
  test.skip(shouldSkipBrowserSpecs(), "Set E2E_BASE_URL to run browser specs");

  test("Desktop: sidebar is visible by default, toggle is hidden", async ({ page }) => {
    // 1920x1080 is typical desktop
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    const menuToggle = page.locator("#menu-toggle");

    await expect(sidebar).toBeVisible();
    await expect(menuToggle).not.toBeVisible();
  });

  test("Mobile: bottom navigation is the primary shell and sidebar stays closed", async ({ page }) => {
    // 375x812 is iPhone X
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    const bottomNav = page.locator("#mobile-tab-bar");

    await expect(bottomNav).toBeVisible();
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(sidebar).toHaveCSS("visibility", "hidden");
    await expect(sidebar).toHaveCSS("pointer-events", "none");
  });

  test("Mobile: bottom navigation marks Dashboard active on the dashboard", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bottomNav = page.locator("#mobile-tab-bar");
    await expect(bottomNav).toBeVisible();
    await expect(bottomNav.locator('[data-page="dashboard"]')).toHaveClass(/active/);
    await expect(bottomNav.locator('[data-page="dashboard"]')).toHaveAttribute("aria-current", "page");
    await expect(bottomNav.locator('[data-page="today"]')).not.toHaveClass(/active/);
  });

  test("Mobile: closed sidebar is not visible or interactive", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const sidebar = page.locator("#sidebar");
    await expect(sidebar).not.toHaveClass(/open/);
    await expect(sidebar).toHaveCSS("visibility", "hidden");
    await expect(sidebar).toHaveCSS("pointer-events", "none");
  });

  test("Mobile: sidebar hierarchy actions are discoverable touch targets when opened", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.locator("#sidebar").evaluate((sidebar) => sidebar.classList.add("open"));

    const firstAction = page.locator(".stree__action-btn").first();
    const actionCount = await page.locator(".stree__action-btn").count();
    test.skip(actionCount === 0, "No hierarchy action buttons in this fixture");

    const metrics = await firstAction.evaluate((action) => {
      const rect = action.getBoundingClientRect();
      const actionGroup = action.closest(".stree__actions");
      return {
        width: rect.width,
        height: rect.height,
        opacity: actionGroup ? getComputedStyle(actionGroup).opacity : "",
      };
    });
    expect(metrics.opacity).toBe("1");
    expect(metrics.width).toBeGreaterThanOrEqual(44);
    expect(metrics.height).toBeGreaterThanOrEqual(44);
  });

  test("Mobile: bottom navigation does not inherit desktop shortcut badges", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const bottomNav = page.locator("#mobile-tab-bar");
    await expect(bottomNav).toBeVisible();
    expect(await bottomNav.locator("[data-shortcut]").count()).toBe(0);
    expect(await bottomNav.locator(".shortcut-badge").count()).toBe(0);
  });

  test("Mobile: Calendar tab targets the consolidated task calendar view", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/", { waitUntil: "domcontentloaded" })

    const calendarTab = page.locator('#mobile-tab-bar [data-page="calendar"]');
    await expect(calendarTab).toHaveAttribute("href", "/tasks?view=calendar#calendar");

    await calendarTab.click();
    await expect(page).toHaveURL(/\/tasks\?view=calendar#calendar$/);
    await expect(calendarTab).toHaveClass(/active/);
    await expect(calendarTab).toHaveAttribute("aria-current", "page");
  });

  test("Mobile: direct Calendar view is current before hash normalization", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    // Block deferred scripts so the document keeps its incoming query URL.
    await page.route("**/*", route =>
      route.request().resourceType() === "script" ? route.abort() : route.continue(),
    )
    await page.goto("/tasks?view=calendar")

    const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" })
    await expect(page).toHaveURL(/\/tasks\?view=calendar$/)
    await expect(page.locator("#tasks-view-calendar")).toBeVisible()
    await expect(bottomNav.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(bottomNav.locator('[data-page="calendar"]')).toHaveAttribute("aria-current", "page")
  })

  test("Tasks view links use native keyboard order and identify the current page", async ({ page }) => {
    await page.goto("/tasks?status=active#kanban")
    const views = page.getByRole("navigation", { name: "Task views" })
    const kanban = views.getByRole("link", { name: "Kanban" })
    const table = views.getByRole("link", { name: "Table" })
    // A narrow header may move native links into the closed More menu.
    const allViews = views.locator("a[data-view-tab]")
    await expect(allViews).toHaveCount(4)
    for (const id of ["kanban", "table", "calendar", "timeline"]) {
      await expect(views.locator(`a[data-view-tab="${id}"]`)).toHaveAttribute("href", new RegExp(`#${id}$`))
    }
    await expect(views.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(kanban).toHaveAttribute("aria-current", "page")

    await kanban.focus()
    await page.keyboard.press("Tab")
    await expect(table).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(page).toHaveURL(/\/tasks\?status=active&view=table#table$/)
    await expect(views.locator('[aria-current="page"]')).toHaveCount(1)
    await expect(table).toHaveAttribute("aria-current", "page")
  })

  test("Settings -> Dashboard under HA ingress does not bounce back to /settings", async ({ page, baseURL }) => {
    const ingressPrefix = "/api/hassio_ingress/test-token";
    const origin = new URL(baseURL!).origin;

    await page.route(`${origin}${ingressPrefix}**`, async (route) => {
      const reqUrl = new URL(route.request().url());
      const strippedPath = reqUrl.pathname.slice(ingressPrefix.length) || "/";
      const targetUrl = `${origin}${strippedPath}${reqUrl.search}`;
      const response = await page.request.fetch(targetUrl, {
        method: route.request().method(),
        headers: {
          ...route.request().headers(),
          "x-ingress-path": ingressPrefix,
          origin,
        },
      });
      const contentType = response.headers()["content-type"] || "";
      if (contentType.includes("text/html")) {
        const rawHtml = await response.text();
        const rewritten = rawHtml
          .replace("<head>", `<head><script>window.__ingress_path=${JSON.stringify(ingressPrefix)};</script>`)
          .replace(/href="\/(?!\/)/g, `href="${ingressPrefix}/`);
        await route.fulfill({
          status: response.status(),
          headers: response.headers(),
          body: rewritten,
        });
        return;
      }
      await route.fulfill({ response });
    });

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${ingressPrefix}/settings`, { waitUntil: "networkidle" });
    await expect(page.locator("#settings-shell")).toBeVisible();

    await page.locator('.sidebar .nav-link[data-page="dashboard"]').click();
    await expect(page).toHaveURL(new RegExp(`${ingressPrefix}/?$`));
    await expect(page.locator("#main-content")).toBeVisible();

    // Wait past any delayed restore scripts and ensure we did not bounce back to /settings
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(new RegExp(`${ingressPrefix}/?$`));
    const storedPath = await page.evaluate(() => {
      const raw = sessionStorage.getItem("meitheal-navigation-state");
      return raw ? JSON.parse(raw).path : null;
    });
    expect(storedPath).toBe("/");
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test('Desktop: "Every Day" project label in Areas tree is not prematurely truncated', async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin };
    const areaRes = await request.post("/api/areas", {
      headers,
      data: { name: `Routine Area ${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(areaRes.status()).toBe(201);
    const { id: areaId } = await areaRes.json();
    let projectId: string | undefined;

    try {
      const projectRes = await request.post("/api/projects", {
        headers,
        data: { title: "Every Day", area_id: areaId },
      });
      expect(projectRes.status()).toBe(201);
      projectId = (await projectRes.json()).id;

      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto("/", { waitUntil: "networkidle" });

      const area = page.locator(`[data-area-group="${areaId}"]`);
      const toggle = area.locator(".stree__area-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }

      const label = area.locator(`.stree__project-link[href="/projects/${projectId}"] .stree__project-name`);
      await expect(label).toHaveText("Every Day");
      const metrics = await label.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        textWidth: el.getBoundingClientRect().width,
      }));
      expect(metrics.textWidth).toBeGreaterThan(50);
      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    } finally {
      if (projectId) await request.delete(`/api/projects/${projectId}`, { headers });
      await request.delete(`/api/areas/${areaId}`, { headers });
    }
  });

  test("Desktop: shortcut badges render inline inside nav row bounds without clipping", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/", { waitUntil: "networkidle" });

    const todayLink = page.locator('.sidebar .nav-link[data-page="today"]');
    await expect(todayLink).toBeVisible();
    await todayLink.hover();

    const badge = todayLink.locator(".shortcut-badge");
    await expect(badge).toBeVisible();
    const layout = await todayLink.evaluate((link) => {
      const badgeEl = link.querySelector<HTMLElement>(".shortcut-badge");
      if (!badgeEl) return null;
      const l = link.getBoundingClientRect();
      const b = badgeEl.getBoundingClientRect();
      return {
        position: getComputedStyle(badgeEl).position,
        insideX: b.left >= l.left - 0.5 && b.right <= l.right + 0.5,
        insideY: b.top >= l.top - 0.5 && b.bottom <= l.bottom + 0.5,
      };
    });
    expect(layout).not.toBeNull();
    expect(layout!.position).toBe("static");
    expect(layout!.insideX).toBe(true);
    expect(layout!.insideY).toBe(true);

    await page.locator("#sidebar-edge-toggle").click();
    await expect(page.locator("body")).toHaveClass(/sidebar-collapsed/);
    await todayLink.hover();
    await expect(badge).toBeHidden();
  });

  test("Task Types submenu toggle, visibility config, pinning, and Events filter work end-to-end", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => localStorage.removeItem("meitheal-task-nav-prefs"));
    await page.goto("/", { waitUntil: "networkidle" });

    await page.locator("#tasks-submenu-toggle").click();
    const submenu = page.locator("#tasks-nav-submenu");
    await expect(submenu).toBeVisible();
    await expect(submenu.locator('[data-task-nav-item="standard"]')).toBeVisible();
    await expect(submenu.locator('[data-task-nav-item="shopping_item"]')).toBeVisible();
    await expect(submenu.locator('[data-task-nav-item="checklist"]')).toBeVisible();
    await expect(submenu.locator('[data-task-nav-item="calendar_event"]')).toBeVisible();

    await page.locator("#tasks-submenu-config-btn").click();
    const popover = page.locator("#tasks-nav-config-popover");
    await expect(popover).toBeVisible();
    await popover.locator('[data-task-nav-mode="none"]').click();
    await expect(submenu).toBeHidden();

    await popover.locator('[data-task-nav-mode="all"]').click();
    await expect(submenu).toBeVisible();

    await popover.locator('[data-task-nav-toggle="shopping_item"]').click();
    await expect(submenu.locator('[data-task-nav-item="shopping_item"]')).toBeHidden();
    await popover.locator('[data-task-nav-toggle="shopping_item"]').click();
    await expect(submenu.locator('[data-task-nav-item="shopping_item"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(popover).toBeHidden();

    await submenu.locator('[data-task-nav-item="calendar_event"] [data-task-nav-pin="calendar_event"]').click();
    const pinnedRow = page.locator('[data-task-nav-pinned-item="calendar_event"]');
    await expect(pinnedRow).toBeVisible();

    await pinnedRow.locator('[data-task-nav-pinned-link="calendar_event"]').click();
    await expect(page).toHaveURL(/\/tasks\?types=calendar_event/);

    await expect(pinnedRow.locator('[data-task-nav-pinned-link="calendar_event"]')).toHaveClass(/active/);
    await expect(page.locator('.sidebar .nav-link[data-page="tasks"]')).not.toHaveClass(/active/);
    await expect(page.locator('.filter-toolbar__type-btn[data-type="calendar_event"]').first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.filter-toolbar__type-btn[data-type="shopping_item"]').first()).toHaveAttribute("aria-pressed", "false");

    await pinnedRow.locator(".task-nav-unpin-btn").click();
    await expect(pinnedRow).toBeHidden();
  });
});
