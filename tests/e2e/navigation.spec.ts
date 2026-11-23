import { test, expect } from "@playwright/test";
import { currentBoardWriteHeaders } from "../helpers/current-board-http"
import { saveAppearance } from "../helpers/appearance-settings"
import { readScopedNavigation, shouldSkipBrowserSpecs } from "./_helpers";

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

  test("renaming a sidebar area also updates its accessible controls", async ({ page, request }) => {
    const headers = await currentBoardWriteHeaders(request, "household", {})
    const created = await request.post("/api/areas", { headers, data: { name: "Sidebar rename fixture" } })
    expect(created.status()).toBe(201)
    const { id: areaId } = await created.json()
    await page.setViewportSize({ width: 1440, height: 960 })
    await page.goto("/")
    const household = page.locator('[data-named-board-shortcut="household"]')
    const boardsToggle = page.locator("[data-sidebar-boards-toggle]")
    if (await boardsToggle.getAttribute("aria-expanded") === "false") await boardsToggle.click()
    const areasToggle = household.locator(".sidebar-board-toggle")
    if (await areasToggle.getAttribute("aria-expanded") === "false") await areasToggle.click()
    try {
      const row = household.locator(`[data-area-group="${areaId}"] .stree__area-row`)
      const toggle = row.locator("[data-area-toggle]")
      const menu = row.locator("[data-area-menu]")
      const name = "Renamed fixture area"
      const initiallyExpanded = await toggle.getAttribute("aria-expanded") === "true"
      await row.hover()
      await menu.click()
      await page.locator('#area-menu-dropdown [data-action="rename"]').click()
      const input = row.locator(".stree__inline-input")
      await input.fill(name)
      await input.press("Enter")
      await expect(toggle).toHaveAccessibleName(`Projects in ${name}`)
      await expect(toggle).toHaveAttribute("data-area-name-label", name)
      await expect(menu).toHaveAccessibleName(new RegExp(name + "$"))
      await expect(row.locator("[data-area-add]")).toHaveAccessibleName(`New project in ${name}`)
      await expect(toggle).toHaveAttribute("title", (initiallyExpanded ? "Collapse " : "Expand ") + name)
      await toggle.click()
      await expect(toggle).toHaveAttribute("title", (initiallyExpanded ? "Expand " : "Collapse ") + name)
    } finally {
      await request.delete(`/api/areas/${areaId}`, { headers })
    }
  })

  test("Mobile: sidebar hierarchy actions are discoverable touch targets when opened", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    await page.locator("#sidebar").evaluate((sidebar) => sidebar.classList.add("open"));

    const firstAction = page.locator(".stree__action-btn").first();
    const actionCount = await page.locator(".stree__action-btn").count();
    test.skip(actionCount === 0, "No hierarchy action buttons in this fixture");

    await expect(firstAction.locator("..")).toHaveCSS("opacity", "1")
    await firstAction.focus()
    const metrics = await firstAction.evaluate((action) => {
      const rect = action.getBoundingClientRect();
      const actionGroup = action.closest(".stree__actions");
      return {
        width: rect.width,
        height: rect.height,
        opacity: actionGroup ? getComputedStyle(actionGroup).opacity : "",
        groupWidth: actionGroup?.getBoundingClientRect().width ?? 0,
      };
    });
    expect(metrics.opacity).toBe("1");
    expect(metrics.groupWidth).toBeGreaterThanOrEqual(92)
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

  test("Mobile: Calendar and Tasks tabs identify the active view on the Household Board", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 })
    await page.goto("/", { waitUntil: "domcontentloaded" })

    const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" })
    const calendarTab = bottomNav.locator('[data-page="calendar"]')
    await expect(calendarTab).toHaveAttribute("href", "/boards/household?view=calendar#calendar")
    await calendarTab.click()
    await expect(page).toHaveURL("/boards/household?view=calendar#calendar")
    await expect(calendarTab).toHaveClass(/active/)
    await expect(calendarTab).toHaveAttribute("aria-current", "page")
    await expect(bottomNav.locator('[aria-current="page"]')).toHaveCount(1)

    const tasksTab = bottomNav.locator('[data-page="tasks"]')
    await tasksTab.click()
    await expect(page).toHaveURL("/boards/household#kanban")
    await expect(tasksTab).toHaveAttribute("aria-current", "page")
    await expect(calendarTab).not.toHaveAttribute("aria-current", "page")
  })

  for (const calendarPath of ["/tasks?view=calendar", "/boards/household?view=calendar"]) {
    test(`Mobile: ${calendarPath} is current before hash normalization`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 })
      // Block deferred scripts so the document keeps its incoming query URL.
      await page.route("**/*", route =>
        route.request().resourceType() === "script" ? route.abort() : route.continue(),
      )
      await page.goto(calendarPath)

      const bottomNav = page.getByRole("navigation", { name: "Mobile navigation" })
      await expect(page).toHaveURL(calendarPath)
      await expect(page.locator("#tasks-view-calendar")).toBeVisible()
      await expect(bottomNav.locator('[aria-current="page"]')).toHaveCount(1)
      await expect(bottomNav.locator('[data-page="calendar"]')).toHaveAttribute("aria-current", "page")
    })
  }

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
    const dashboard = `${origin}${ingressPrefix}/?view=dashboard`;
    await expect(page).toHaveURL(dashboard);
    await expect(page.locator("#main-content")).toBeVisible();

    // Wait past any delayed restore scripts and ensure we did not bounce back to /settings
    await page.waitForTimeout(400);
    await expect(page).toHaveURL(dashboard);
    expect(await readScopedNavigation(page)).toMatchObject({ path: "/?view=dashboard" });
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test('Desktop: "Every Day" project label in Areas tree is not prematurely truncated', async ({ page, request, baseURL }) => {
    const headers = await currentBoardWriteHeaders(request, "household", { origin: new URL(baseURL!).origin })
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

      const household = page.locator('[data-named-board-shortcut="household"]')
      const boardsToggle = page.locator("[data-sidebar-boards-toggle]")
      if (await boardsToggle.getAttribute("aria-expanded") === "false") await boardsToggle.click()
      const areasToggle = household.locator(".sidebar-board-toggle")
      if (await areasToggle.getAttribute("aria-expanded") === "false") await areasToggle.click()

      const area = page.locator(`[data-area-group="${areaId}"]`);
      const toggle = area.locator(".stree__area-toggle");
      if ((await toggle.getAttribute("aria-expanded")) === "false") {
        await toggle.click();
      }

      const label = area.locator(`.stree__project-link[data-project-id="${projectId}"] .stree__project-name`);
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

  test("Desktop: Task view menu and pins work when Tasks is ordered after Areas", async ({ page, request, baseURL }) => {
    const headers = { origin: new URL(baseURL!).origin };
    const before = await (await request.get("/api/settings")).json();
    const prevSidebar = before.sidebar_config;
    try {
      expect((await request.put("/api/settings", {
        headers,
        data: {
          key: "sidebar_config",
          value: { dashboard: true, today: true, areas: true, tasks: true, order: ["dashboard", "today", "areas", "tasks"] },
        },
      })).status()).toBe(200);

      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto("/", { waitUntil: "networkidle" });
      await page.evaluate(() => localStorage.removeItem("meitheal-task-nav-prefs"));
      await page.reload({ waitUntil: "networkidle" });

      await page.locator("#tasks-submenu-toggle").click();
      await expect(page.locator("#tasks-nav-submenu")).toBeVisible();
      const pinBtn = page.locator('#tasks-nav-submenu [data-task-view-pin="calendar"]');
      await pinBtn.click();
      await expect(pinBtn).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('.nav-item--tasks ~ [data-sidebar-group="view-calendar"]')).toBeVisible();
    } finally {
      await page.evaluate(() => localStorage.removeItem("meitheal-task-nav-prefs")).catch(() => {});
      await request.put("/api/settings", {
        headers,
        data: { key: "sidebar_config", value: prevSidebar ?? null },
      }).catch(() => {});
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
    // The sidebar can re-render its counts after earlier specs add tasks, which drops
    // the hover state. Re-hover until the badge is measured while it is shown.
    await expect.poll(async () => {
      await todayLink.hover();
      return todayLink.evaluate((link) => {
        const badgeEl = link.querySelector<HTMLElement>(".shortcut-badge");
        return badgeEl ? getComputedStyle(badgeEl).display : "missing";
      });
    }).not.toBe("none");
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

  test("Kanban type filters still open a filtered task list", async ({ page }) => {
    await page.goto("/tasks?types=calendar_event#kanban", { waitUntil: "networkidle" });
    await expect(page.locator('.filter-toolbar__type-btn[data-type="calendar_event"]').first()).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator('.filter-toolbar__type-btn[data-type="shopping_item"]').first()).toHaveAttribute("aria-pressed", "false");
  });

  test("Settings Navigation pins and task nav modes apply once without double-toggling", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("nav-pin-test-init")) {
        sessionStorage.setItem("nav-pin-test-init", "1");
        localStorage.removeItem("meitheal-task-nav-prefs");
      }
    });
    await page.goto("/settings#navigation-settings", { waitUntil: "networkidle" });
    await expect(page.locator("#settings-panels")).not.toHaveAttribute("inert", "");

    const navSection = page.locator("#navigation-settings");
    const pinBtn = navSection.locator('[data-task-nav-pin="calendar_event"]');
    const pinnedRow = page.locator('#sidebar-task-types [data-task-nav-pinned-item="calendar_event"]');
    // Task type pins live in the collapsed Task types accordion.
    const taskTypes = page.locator("#nav-task-types-section > summary");

    await expect(pinBtn).toHaveAttribute("aria-pressed", "false");
    await taskTypes.click();
    await pinBtn.click();
    await expect(pinBtn).toHaveAttribute("aria-pressed", "true");
    await expect(pinnedRow).toBeVisible();

    await navSection.locator('[data-task-nav-mode="none"]').click();
    await expect(navSection.locator('[data-task-nav-mode="none"]')).toHaveAttribute("aria-pressed", "true");

    await page.reload({ waitUntil: "networkidle" });
    await expect(pinBtn).toHaveAttribute("aria-pressed", "true");
    await expect(pinnedRow).toBeVisible();
    await expect(navSection.locator('[data-task-nav-mode="none"]')).toHaveAttribute("aria-pressed", "true");

    if (!(await pinBtn.isVisible())) await taskTypes.click();
    await pinBtn.click();
    await expect(pinBtn).toHaveAttribute("aria-pressed", "false");
    await expect(pinnedRow).toBeHidden();
  });

  test("task-nav Shopping stays available after changing navigation layout and on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/settings#navigation-settings", { waitUntil: "networkidle" });

    const navSection = page.locator("#navigation-settings");
    const pinBtn = navSection.locator('[data-task-nav-pin="shopping_item"]');
    const pinnedRow = page.locator('#sidebar [data-task-nav-pinned-item="shopping_item"]');
    // Navigation layout is part of the Look & Feel draft.
    const setNavigationLayout = async (mode: "navbar" | "sidebar") => {
      await page.goto("/settings#look-and-feel-settings");
      await page.locator('#appearance-preferences-form [name="navigation"]').selectOption(mode);
      await saveAppearance(page);
    };

    try {
      await expect(pinBtn).toHaveAttribute("aria-pressed", "false");
      await page.locator("#nav-task-types-section > summary").click();
      await pinBtn.click();
      await expect(pinBtn).toHaveAttribute("aria-pressed", "true");
      await expect(pinnedRow).toBeVisible();

      await setNavigationLayout("navbar");
      await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar");
      const pinnedShopping = pinnedRow.getByRole("button", { name: "New shopping list", exact: true });
      await pinnedShopping.click();
      await expect(page.locator("#new-task-kind")).toHaveValue("shopping_item");
      await page.keyboard.press("Escape");
      await expect(page.locator("#new-task-overlay")).toBeHidden();
      await expect(pinnedShopping).toBeFocused();

      await setNavigationLayout("sidebar");
      await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "sidebar");
      await expect(pinnedRow).toBeVisible();

      await setNavigationLayout("navbar");
      await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar");

      await expect(pinnedRow).toBeVisible()
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(page.locator("html")).toHaveAttribute("data-appearance-navigation", "navbar")
      await expect(page).toHaveURL(/settings#look-and-feel-settings$/)
      await expect(pinnedRow).toHaveCount(1)
      await page.goto("/", { waitUntil: "networkidle" })
      await page.locator("#menu-toggle").click()
      await expect(page.locator("#tasks-submenu-toggle")).toBeVisible();
      await expect(page.locator("#sidebar-task-types [data-task-creation-toggle]")).toBeVisible();
      await expect(pinnedRow).toBeVisible();
    } finally {
      await page.evaluate(() => {
        localStorage.removeItem("meitheal-task-nav-prefs");
        localStorage.removeItem("meitheal-appearance");
      });
    }
  });

  test("sidebar #nav-count-tasks stays opt-in by default and hydrates live when mounted", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/", { waitUntil: "networkidle" });

    const tasksLink = page.locator('.sidebar .nav-link[data-page="tasks"]');
    await expect(tasksLink).toBeVisible();
    const badge = page.locator("#nav-count-tasks");
    await expect(badge).toHaveCount(0);

    await tasksLink.evaluate((link) => {
      const span = document.createElement("span");
      span.id = "nav-count-tasks";
      span.className = "nav-badge";
      span.hidden = true;
      span.setAttribute("aria-label", "0 active");
      span.textContent = "0";
      const shortcut = link.querySelector(".shortcut-badge");
      link.insertBefore(span, shortcut ?? null);
    });
    await expect(badge).toBeHidden();

    const beforeTotal = await page.evaluate(async () => {
      const res = await fetch("/api/tasks?status=active&deferred=0&limit=1");
      const data = await res.json();
      return Number(data.total ?? 0);
    });

    let createdId: string | undefined;
    try {
      createdId = await page.evaluate(async () => {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Badge Hydration Probe", status: "active" }),
        });
        const data = await res.json();
        window.dispatchEvent(new CustomEvent("meitheal-tasks-changed"));
        return data.id as string;
      });

      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(String(beforeTotal + 1));
      await expect(badge).toHaveAttribute("aria-label", `${beforeTotal + 1} active`);
    } finally {
      if (createdId) {
        await page.evaluate(async (id) => {
          await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
          window.dispatchEvent(new CustomEvent("meitheal-tasks-changed"));
        }, createdId);
        if (beforeTotal === 0) {
          await expect(badge).toBeHidden();
        }
      }
    }
  });

  test("legacy /tasks?types=standard alias normalizes in Table and Timeline views", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto("/", { waitUntil: "networkidle" });

    const suffix = String(Date.now());
    const stdTitle = `Standard Alias Probe ${suffix}`;
    const shopTitle = `Shopping Alias Probe ${suffix}`;
    const todayIso = new Date().toISOString().slice(0, 10);

    const created = await page.evaluate(async ({ stdTitle, shopTitle, todayIso }) => {
      const create = async (body: Record<string, unknown>) => {
        const res = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return data.id as string;
      };
      return {
        stdId: await create({ title: stdTitle, task_kind: "standard_action", status: "pending", due_date: todayIso }),
        shopId: await create({ title: shopTitle, task_kind: "shopping_item", status: "pending", due_date: todayIso }),
      };
    }, { stdTitle, shopTitle, todayIso });

    try {
      await page.goto("/tasks?types=standard&view=table", { waitUntil: "networkidle" });
      await expect(page.locator('#tasks-view-table .filter-toolbar__type-btn[data-type="standard_action"]')).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('#tasks-view-table .filter-toolbar__type-btn[data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("#tasks-view-table").getByText(stdTitle)).toBeVisible();
      await expect(page.locator("#tasks-view-table").getByText(shopTitle)).toBeHidden();

      await page.goto("/tasks?types=standard&view=timeline", { waitUntil: "networkidle" });
      await expect(page.locator('#tasks-view-timeline .filter-toolbar__type-btn[data-type="standard_action"]')).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator('#tasks-view-timeline .filter-toolbar__type-btn[data-type="shopping_item"]')).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator("#tasks-view-timeline").getByText(stdTitle)).toBeVisible();
      await expect(page.locator("#tasks-view-timeline").getByText(shopTitle)).toBeHidden();
    } finally {
      await page.evaluate(async ({ stdId, shopId }) => {
        for (const id of [stdId, shopId]) {
          await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
        }
      }, created);
    }
  });
});
