import { exportLocalDataAsJson } from "@domains/offline/export-service"
import { confirmDialog } from "@lib/confirm-dialog"
import { settingsStore } from "@lib/settings-store"
import { showToast } from "@lib/toast"
import {
  setTheme as importedSetTheme,
  applyCustomTheme as importedApplyCustomTheme,
} from "@lib/theme-watcher"
import type { ThemeMode } from "@lib/theme-watcher"

export function initSettingsController(): void {

    document
      .getElementById("export-json-btn")
      ?.addEventListener("click", async (e) => {
        e.preventDefault();
        try {
          await exportLocalDataAsJson();
          showToast("settings.export_success");
        } catch (err) {
          console.error("Failed to export JSON:", err);
          showToast("settings.export_failed", "error");
        }
      });

    // Raw DB download with confirmation dialog
    document
      .getElementById("export-db-btn")
      ?.addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          message:
            "This will download the entire raw SQLite database file. Continue?",
          title: "Download Database",
          confirmText: "Download",
          variant: "warning",
        });
        if (!confirmed) return;
        const a = document.createElement("a");
        a.href = "/api/export/database.sqlite";
        a.download = "";
        document.body.appendChild(a);
        a.click();
        a.remove();
      });

    // Import Config Binding
    const importInput = document.getElementById(
      "import-settings-input",
    ) as HTMLInputElement;
    if (importInput) {
      importInput.addEventListener("change", async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        try {
          const text = await file.text();
          const payload = JSON.parse(text);

          const response = await fetch(
            (window.__ingress_path || "") + "/api/import/settings",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            },
          );

          if (!response.ok) {
            throw new Error(await response.text());
          }

          showToast("settings.import_success");
          settingsStore.invalidate()
          setTimeout(() => window.location.reload(), 1500);
        } catch (error) {
          console.error("Failed to import settings:", error);
          showToast("settings.import_failed", "error");
        }
      });
    }

    /** Max custom theme CSS file size in bytes */
    const MAX_THEME_SIZE = 51200; // 50KB

    /** Dangerous CSS patterns to strip from imported themes */
    const DANGEROUS_CSS_PATTERNS = [
      /@import\b[^;]*;/gi,
      /url\s*\([^)]*\)/gi,
      /expression\s*\([^)]*\)/gi,
      /javascript\s*:/gi,
      /behavior\s*:/gi,
      /-moz-binding\s*:/gi,
      /<script/gi,
      /<\/style/gi,
      /<\/script/gi,
    ];

    /** Sanitize CSS content by stripping dangerous patterns */
    function sanitizeCSS(css: string): string {
      let safe = css;
      for (const pattern of DANGEROUS_CSS_PATTERNS) {
        safe = safe.replace(pattern, "/* [removed] */");
      }
      return safe;
    }

    /** Show/hide the custom theme section */
    function showCustomThemeSection(show: boolean): void {
      const section = document.getElementById("custom-theme-section");
      if (section) section.style.display = show ? "block" : "none";
    }

    /** Update the custom theme loaded display */
    function updateCustomThemeDisplay(filename: string | null): void {
      const emptyEl = document.getElementById("custom-theme-empty");
      const loadedEl = document.getElementById("custom-theme-loaded");
      const nameEl = document.getElementById("custom-theme-filename");
      if (!emptyEl || !loadedEl || !nameEl) return;
      if (filename) {
        emptyEl.style.display = "none";
        loadedEl.style.display = "flex";
        nameEl.textContent = filename;
      } else {
        emptyEl.style.display = "flex";
        loadedEl.style.display = "none";
        nameEl.textContent = "";
      }
    }

    // Save a setting to the API
    async function saveSetting(key: string, value: unknown) {
      try {
        await settingsStore.saveSetting(key, value)
      } catch {
        /* ignore */
      }
    }

    // Load settings from API on page init
    async function loadSettings() {
      let settings: Record<string, any> = {}
      try {
        settings = await settingsStore.load()
      } catch (e) {
        console.error("[Settings] Failed to load settings from API:", e);
        // Fall back to localStorage for locale
        const stored = localStorage.getItem("meitheal-locale") || "en";
        (document.getElementById("locale-select") as HTMLSelectElement).value =
          stored;
        return;
      }

      try {
        if (settings.framework_mapping) {
          const mapping = settings.framework_mapping as Record<
            string,
            string[]
          >;
          document
            .querySelectorAll(".framework-mapping-select")
            .forEach((sel) => {
              const select = sel as HTMLSelectElement;
              const taskType = select.dataset.taskType;
              if (
                taskType &&
                mapping[taskType] &&
                Array.isArray(mapping[taskType])
              ) {
                const selectedVals = mapping[taskType];
                Array.from(select.options).forEach((opt) => {
                  opt.selected = selectedVals.includes(opt.value);
                });
              }
            });
        }

        // Restore locale
        if (settings.locale) {
          (
            document.getElementById("locale-select") as HTMLSelectElement
          ).value = String(settings.locale);
        } else {
          // Fall back to localStorage / cookie
          const stored = localStorage.getItem("meitheal-locale") || "en";
          (
            document.getElementById("locale-select") as HTMLSelectElement
          ).value = stored;
        }
      } catch (e) {
        console.error("[Settings] Framework mapping error:", e);
      }

      try {
        const savedTheme =
          settings.theme || localStorage.getItem("meitheal-theme") || "dark";
        const themeEl = document.getElementById(
          "theme-select",
        ) as HTMLSelectElement;
        if (themeEl) themeEl.value = String(savedTheme);
        // Use setTheme from theme-watcher which handles data-theme, classes, and custom CSS
        importedSetTheme(
          String(savedTheme) as import("@lib/theme-watcher").ThemeMode,
        );
        // Restore custom theme CSS if saved
        if (savedTheme === "custom" && settings.custom_theme_css) {
          localStorage.setItem(
            "meitheal-custom-theme-css",
            String(settings.custom_theme_css),
          );
          importedApplyCustomTheme(String(settings.custom_theme_css));
        }
        // Show custom theme UI if custom is selected
        showCustomThemeSection(String(savedTheme) === "custom");
        if (settings.custom_theme_name) {
          updateCustomThemeDisplay(String(settings.custom_theme_name));
        }
      } catch (e) {
        console.error("[Settings] Theme restore error:", e);
      }

      try {
        const tz =
          settings.timezone ||
          localStorage.getItem("meitheal-timezone") ||
          "Europe/Dublin";
        const tzEl = document.getElementById(
          "timezone-select",
        ) as HTMLSelectElement;
        if (tzEl) tzEl.value = tz;

        // Restore week start
        const ws =
          settings.week_start ||
          localStorage.getItem("meitheal-week-start") ||
          "monday";
        const wsEl = document.getElementById(
          "week-start-select",
        ) as HTMLSelectElement;
        if (wsEl) wsEl.value = ws;

        // Restore date format
        const df =
          settings.date_format ||
          localStorage.getItem("meitheal-date-format") ||
          "relative";
        const dfEl = document.getElementById(
          "date-format-select",
        ) as HTMLSelectElement;
        if (dfEl) dfEl.value = df;
      } catch (e) {
        console.error("[Settings] UI settings error:", e);
      }

      try {
        // Restore sidebar config
        const DEFAULT_SIDEBAR = [
          "dashboard",
          "kanban",
          "tasks",
          "today",
          "upcoming",
          "calendar",
        ];
        const SIDEBAR_LABELS: Record<string, string> = {
          dashboard: "Dashboard",
          kanban: "Kanban Board",
          tasks: "Tasks List",
          table: "Table",
          today: "Today",
          upcoming: "Upcoming",
          calendar: "Calendar",
        };

        let sidebarConfig: Record<string, any> = {};
        try {
          const raw = settings.sidebar_config;
          if (raw) {
            sidebarConfig = typeof raw === "string" ? JSON.parse(raw) : raw;
          }
        } catch { /* non-fatal */ }

        let orderItems =
          Array.isArray(sidebarConfig.order) && sidebarConfig.order.length > 0
            ? [...sidebarConfig.order]
            : [...DEFAULT_SIDEBAR];
        // Make sure missing default items are appended
        DEFAULT_SIDEBAR.forEach((k) => {
          if (!orderItems.includes(k)) {
            orderItems.push(k);
          }
        });

        const customItems: {
          id: string;
          label: string;
          href: string;
          icon: string;
        }[] = Array.isArray(sidebarConfig.customItems)
          ? sidebarConfig.customItems
          : [];

        let dragSrcIndex: number | null = null;

        // Create a 1x1 transparent image for custom drag ghost
        const dragGhost = document.createElement("canvas");
        dragGhost.width = 1;
        dragGhost.height = 1;

        function clearDropIndicators(list: HTMLElement) {
          list.querySelectorAll(".sidebar-config-row").forEach((r) => {
            const el = r as HTMLElement;
            el.style.borderTopColor = "var(--border)";
            el.style.borderBottomColor = "var(--border)";
            el.style.borderTopWidth = "1px";
            el.style.borderBottomWidth = "1px";
          });
        }

        function renderSidebarList() {
          const list = document.getElementById("sidebar-item-list")!;
          list.innerHTML = "";
          orderItems.forEach((key: string, index: number) => {
            const isVisible = sidebarConfig[key] !== false;
            const labelStr =
              (sidebarConfig.labels && sidebarConfig.labels[key]) ||
              SIDEBAR_LABELS[key] ||
              key;

            const row = document.createElement("div");
            row.className = "sidebar-config-row";
            row.draggable = true;
            row.dataset.index = String(index);
            row.style.cssText =
              "display: flex; gap: 8px; align-items: center; background: var(--bg-secondary); padding: 8px; border-radius: 4px; border: 1px solid var(--border); margin-bottom: 4px;";

            row.innerHTML = `
            <div class="drag-handle" title="Drag to reorder" style="cursor: grab; color: var(--text-muted); padding: 4px 8px; user-select: none; border-radius: 4px; transition: color 0.15s, background 0.15s; display: flex; align-items: center; justify-content: center;" onmouseover="this.style.color='var(--text-primary)'; this.style.background='var(--bg-hover)'" onmouseout="this.style.color='var(--text-muted)'; this.style.background='transparent'">☰</div>
            <input type="checkbox" class="sidebar-visible-cb" data-key="${key}" ${isVisible ? "checked" : ""} />
            <span style="min-width: 100px; font-weight: 500;">${SIDEBAR_LABELS[key] || key}</span>
            <input type="text" class="form-input sidebar-label-input" data-key="${key}" value="${labelStr}" placeholder="Custom Label" style="flex: 1; max-width: 240px;" />
          `;

            // Drag events
            row.addEventListener("dragstart", (e) => {
              dragSrcIndex = index;
              row.style.opacity = "0.3";
              row.style.background = "var(--bg-tertiary)";
              e.dataTransfer!.effectAllowed = "move";
              e.dataTransfer!.setData("text/plain", String(index));
              // Use tiny transparent ghost — hides the browser's default clone
              e.dataTransfer!.setDragImage(dragGhost, 0, 0);
            });

            row.addEventListener("dragend", () => {
              row.style.opacity = "1";
              row.style.background = "var(--bg-secondary)";
              clearDropIndicators(list);
            });

            row.addEventListener("dragover", (e) => {
              e.preventDefault();
              e.dataTransfer!.dropEffect = "move";
              if (dragSrcIndex === null || dragSrcIndex === index) return;

              // Show drop indicator: thick accent line on top or bottom edge
              clearDropIndicators(list);
              const rect = row.getBoundingClientRect();
              const midY = rect.top + rect.height / 2;
              if (e.clientY < midY) {
                row.style.borderTopColor = "var(--accent)";
                row.style.borderTopWidth = "3px";
              } else {
                row.style.borderBottomColor = "var(--accent)";
                row.style.borderBottomWidth = "3px";
              }
            });

            row.addEventListener("dragleave", () => {
              row.style.borderTopColor = "var(--border)";
              row.style.borderBottomColor = "var(--border)";
              row.style.borderTopWidth = "1px";
              row.style.borderBottomWidth = "1px";
            });

            row.addEventListener("drop", (e) => {
              e.preventDefault();
              e.stopPropagation();
              if (dragSrcIndex === null || dragSrcIndex === index) return;

              // Determine if dropping above or below this item
              const rect = row.getBoundingClientRect();
              const midY = rect.top + rect.height / 2;
              let targetIndex = index;
              if (e.clientY >= midY && dragSrcIndex < index) {
                targetIndex = index;
              } else if (e.clientY < midY && dragSrcIndex > index) {
                targetIndex = index;
              }

              const movedItem = orderItems.splice(dragSrcIndex, 1)[0];
              orderItems.splice(targetIndex, 0, movedItem);
              clearDropIndicators(list);
              renderSidebarList();
            });

            // Touch drag support (HTML5 drag API doesn't work on touch devices)
            let touchStartY = 0;
            let touchDragging = false;
            row.addEventListener(
              "touchstart",
              (e) => {
                const handle = (e.target as HTMLElement).closest(
                  ".drag-handle",
                );
                if (!handle) return;
                const t0 = e.touches[0];
                if (!t0) return;
                dragSrcIndex = index;
                touchStartY = t0.clientY;
                touchDragging = false;
                row.style.opacity = "0.3";
              },
              { passive: true },
            );

            row.addEventListener(
              "touchmove",
              (e) => {
                if (dragSrcIndex !== index) return;
                const t0 = e.touches[0];
                if (!t0) return;
                const dy = Math.abs(t0.clientY - touchStartY);
                if (dy > 10) {
                  touchDragging = true;
                  e.preventDefault();
                }
                if (!touchDragging) return;
                // Highlight target row
                clearDropIndicators(list);
                const el = document.elementFromPoint(t0.clientX, t0.clientY);
                const targetRow = el?.closest(
                  ".sidebar-config-row",
                ) as HTMLElement | null;
                if (targetRow && targetRow !== row) {
                  targetRow.style.borderTopColor = "var(--accent)";
                  targetRow.style.borderTopWidth = "3px";
                }
              },
              { passive: false },
            );

            row.addEventListener(
              "touchend",
              (e) => {
                if (dragSrcIndex !== index) return;
                row.style.opacity = "1";
                clearDropIndicators(list);
                if (!touchDragging) {
                  dragSrcIndex = null;
                  return;
                }
                const touch = e.changedTouches[0];
                if (!touch) {
                  dragSrcIndex = null;
                  return;
                }
                const el = document.elementFromPoint(
                  touch.clientX,
                  touch.clientY,
                );
                const targetRow = el?.closest(
                  ".sidebar-config-row",
                ) as HTMLElement | null;
                if (targetRow && targetRow !== row) {
                  const targetIdx = Number(targetRow.dataset.index);
                  if (
                    !isNaN(targetIdx) &&
                    dragSrcIndex !== null &&
                    dragSrcIndex !== targetIdx
                  ) {
                    const movedItem = orderItems.splice(dragSrcIndex, 1)[0];
                    orderItems.splice(targetIdx, 0, movedItem);
                    renderSidebarList();
                  }
                }
                dragSrcIndex = null;
                touchDragging = false;
              },
              { passive: true },
            );

            list.appendChild(row);
          });

          // Custom links rendering
          const customList = document.getElementById("custom-links-list")!;
          customList.innerHTML = "";
          customItems.forEach((item, index) => {
            const row = document.createElement("div");
            row.style.cssText =
              "display: flex; gap: 8px; align-items: center; background: var(--bg-secondary); padding: 8px; border-radius: 4px; border: 1px solid var(--border);";
            row.innerHTML = `
              <input type="text" class="form-input custom-item-label" placeholder="Label" value="${item.label.replace(/"/g, "&quot;")}" style="flex: 1;" />
              <input type="text" class="form-input custom-item-href" placeholder="URL (e.g. /notes)" value="${item.href.replace(/"/g, "&quot;")}" style="flex: 2;" />
              <button type="button" class="btn-icon text-danger remove-custom-link" data-index="${index}" style="font-size: 16px;">×</button>
            `;
            customList.appendChild(row);
          });

          document.querySelectorAll(".remove-custom-link").forEach((btn) => {
            btn.addEventListener("click", (e) => {
              const idx = Number(
                (e.currentTarget as HTMLElement).dataset.index,
              );
              customItems.splice(idx, 1);
              renderSidebarList();
            });
          });
        }

        document
          .getElementById("add-custom-link-btn")
          ?.addEventListener("click", () => {
            customItems.push({
              id: `custom-${Date.now()}`,
              label: "New Link",
              href: "/",
              icon: "link",
            });
            renderSidebarList();
          });

        renderSidebarList();

        // Render saved custom fields
        if (settings.custom_fields) {
          try {
            const fields = JSON.parse(settings.custom_fields) as {
              name: string;
              type: string;
            }[];
            const list = document.getElementById("custom-fields-list");
            if (list && fields.length > 0) {
              for (const field of fields) {
                const row = document.createElement("div");
                row.className = "custom-field-row";
                row.innerHTML = `
                  <input type="text" class="form-input" value="${field.name.replace(/"/g, "&quot;")}" disabled />
                  <select class="form-select" disabled>
                    <option value="${field.type}" selected>${field.type.charAt(0).toUpperCase() + field.type.slice(1)}</option>
                  </select>
                  <span style="color: var(--text-muted); font-size: 12px;">Saved</span>
                  <button type="button" class="btn btn-ghost" style="padding: 4px 8px; color: var(--danger);" title="Remove field definition (data on existing tasks is preserved)">×</button>
                `;
                row
                  .querySelector("button")
                  ?.addEventListener("click", async () => {
                    try {
                      const curRes = await fetch(
                        (window.__ingress_path || "") + "/api/settings",
                      );
                      const curSettings = curRes.ok ? await curRes.json() : {};
                      const curFields = curSettings.custom_fields
                        ? JSON.parse(curSettings.custom_fields)
                        : [];
                      const updated = curFields.filter(
                        (f: { name: string }) => f.name !== field.name,
                      );
                      await fetch(
                        (window.__ingress_path || "") + "/api/settings",
                        {
                          method: "PUT",
                          headers: { "content-type": "application/json" },
                          body: JSON.stringify({
                            key: "custom_fields",
                            value: JSON.stringify(updated),
                          }),
                        },
                      );
                      row.remove();
                      showToast("settings.field_removed");
                    } catch {
                      showToast("common.failed_delete", "error");
                    }
                  });
                list.appendChild(row);
              }
            }
          } catch {
            /* skip */
          }
        }
      } catch (e) {
        console.error("[Settings] Sidebar/custom fields error:", e);
      }
    }

    // Contextual framework mapping change (multiple)
    document.querySelectorAll(".framework-mapping-select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const mapping: Record<string, string[]> = {};
        document.querySelectorAll(".framework-mapping-select").forEach((s) => {
          const select = s as HTMLSelectElement;
          const taskType = select.dataset.taskType;
          if (taskType) {
            mapping[taskType] = Array.from(select.selectedOptions).map(
              (o) => o.value,
            );
          }
        });
        saveSetting("framework_mapping", mapping);
        showToast("settings.frameworks_updated");
      });
    });

    // Test HA connection
    document
      .getElementById("test-connection")
      ?.addEventListener("click", async () => {
        const statusEl = document.getElementById("ha-status");
        if (statusEl)
          statusEl.innerHTML =
            '<span style="color: var(--accent);">Testing HA connection...</span>';
        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/ha/connection",
          );
          const data = (await res.json()) as Record<string, unknown>;
          if (statusEl) {
            if (data.connected) {
              const comps = Array.isArray(data.components)
                ? (data.components as string[])
                : [];
              const SHOW_LIMIT = 5;
              const compId = `ha-comp-list-${Date.now()}`;
              let compHtml = "";
              if (comps.length > 0) {
                const preview = comps.slice(0, SHOW_LIMIT);
                const remaining = comps.length - SHOW_LIMIT;
                compHtml = `<div style="margin-top: 8px; padding: 10px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 8px; max-width: 100%; overflow: hidden;">
                  <div style="font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); font-weight: 600; margin-bottom: 6px;">Components (${comps.length})</div>
                  <div style="display: flex; flex-wrap: wrap; gap: 4px;">
                    ${preview.map((c) => `<span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 2px 6px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary);">${c}</span>`).join("")}
                  </div>
                  ${
                    remaining > 0
                      ? `<button type="button" onclick="const el=document.getElementById('${compId}');if(el){el.style.display=el.style.display==='none'?'flex':'none';this.textContent=el.style.display==='none'?'Show all ${comps.length}':'Collapse'}" style="margin-top: 6px; font-size: 11px; color: var(--accent); background: none; border: none; cursor: pointer; padding: 0;">Show all ${comps.length}</button><div id="${compId}" style="display: none; flex-wrap: wrap; gap: 4px; margin-top: 4px;">${comps
                          .slice(SHOW_LIMIT)
                          .map(
                            (c) =>
                              `<span style="font-family: 'JetBrains Mono', monospace; font-size: 11px; padding: 2px 6px; background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-secondary);">${c}</span>`,
                          )
                          .join("")}</div>`
                      : ""
                  }
                </div>`;
              }
              statusEl.innerHTML =
                `<span style="color: var(--accent); font-weight: 500;">✓ Connected</span> <span style="color: var(--text-secondary);">HA ${data.version} (${data.mode})</span>` +
                `<div style="margin-top: 4px; font-size: 12px; color: var(--text-muted);">${data.location_name} · ${data.time_zone}</div>` +
                compHtml;
            } else {
              statusEl.innerHTML =
                `<span style="color: var(--danger);">⚠ ${data.message ?? "HA not reachable"}</span>` +
                `<br><small style="color: var(--text-muted);">Mode: ${data.mode ?? "unknown"}</small>`;
            }
          }
        } catch {
          if (statusEl)
            statusEl.innerHTML =
              '<span style="color: var(--danger);">Connection test failed</span>';
        }
      });

    // Save HA settings (standalone mode only)
    document
      .getElementById("ha-form")
      ?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const haUrl = (document.getElementById("ha-url") as HTMLInputElement)
          .value;
        const haToken = (
          document.getElementById("ha-token") as HTMLInputElement
        ).value;

        const saveBtn = document.getElementById("save-ha") as HTMLButtonElement;
        const origText = saveBtn.innerHTML;
        saveBtn.innerHTML = "💾 Saving...";
        saveBtn.disabled = true;

        await saveSetting("ha_url", haUrl);
        if (haToken) await saveSetting("ha_token", haToken);

        saveBtn.innerHTML = origText;
        saveBtn.disabled = false;
        showToast("settings.ha_saved");
      });

    // Theme Config — init select from localStorage
    const themeSelect = document.getElementById(
      "theme-select",
    ) as HTMLSelectElement;
    if (themeSelect) {
      themeSelect.value = localStorage.getItem("meitheal-theme") || "dark";
      // Show custom section if already on custom
      showCustomThemeSection(themeSelect.value === "custom");
    }

    // Save sidebar config
    document
      .getElementById("save-sidebar")
      ?.addEventListener("click", async () => {
        const list = document.getElementById("sidebar-item-list");
        if (!list) return;

        const config: Record<string, unknown> = {};
        const order: string[] = [];
        const labels: Record<string, string> = {};

        list.querySelectorAll(".sidebar-visible-cb").forEach((cb) => {
          const key = (cb as HTMLElement).dataset.key!;
          config[key] = (cb as HTMLInputElement).checked;
          order.push(key);
        });

        list.querySelectorAll(".sidebar-label-input").forEach((input) => {
          const key = (input as HTMLElement).dataset.key!;
          const val = (input as HTMLInputElement).value.trim();
          if (val) labels[key] = val;
        });

        // Parse custom links
        const finalCustomItems: {
          id: string;
          label: string;
          href: string;
          icon: string;
        }[] = [];
        document.querySelectorAll("#custom-links-list > div").forEach((row) => {
          const label = (
            row.querySelector(".custom-item-label") as HTMLInputElement
          ).value;
          const href = (
            row.querySelector(".custom-item-href") as HTMLInputElement
          ).value;
          if (label || href) {
            finalCustomItems.push({
              id: `custom-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
              label: label || "Link",
              href: href || "/",
              icon: "link",
            });
          }
        });

        config.order = order;
        config.labels = labels;
        config.customItems = finalCustomItems;

        const btn = document.getElementById(
          "save-sidebar",
        ) as HTMLButtonElement;
        if (!btn) return;
        const oText = btn.textContent;
        btn.textContent = "Saving...";
        btn.disabled = true;

        await saveSetting("sidebar_config", config);

        btn.textContent = oText;
        btn.disabled = false;
        showToast("settings.sidebar_saved");
        setTimeout(() => window.location.reload(), 1000);
      });

    // Reset sidebar to defaults
    document
      .getElementById("reset-sidebar")
      ?.addEventListener("click", async () => {
        const confirmed = await confirmDialog({
          message:
            "Reset sidebar to default configuration? Custom links and reordering will be lost.",
          variant: "warning",
        });
        if (!confirmed) return;
        await fetch(
          (window.__ingress_path || "") + "/api/settings?key=sidebar_config",
          {
            method: "DELETE",
          },
        ).catch(() => {});
        await saveSetting("sidebar_config", null);
        showToast("Sidebar reset to defaults");
        setTimeout(() => window.location.reload(), 500);
      });

    // Add custom field
    document
      .getElementById("add-custom-field")
      ?.addEventListener("click", () => {
        const list = document.getElementById("custom-fields-list");
        if (!list) return;
        const row = document.createElement("div");
        row.className = "custom-field-row";
        row.innerHTML = `
        <input type="text" class="form-input" placeholder="Field name" />
        <select class="form-select cf-type-select">
          <option value="text">Text</option>
          <option value="number">Number</option>
          <option value="url">URL</option>
          <option value="select">Select</option>
          <option value="date">Date</option>
          <option value="checkbox">Checkbox</option>
        </select>
        <input type="text" class="form-input cf-options-input" placeholder="Options (comma-separated)" style="display:none; flex:2;" />
        <button type="button" class="btn btn-primary custom-field-save" style="padding: 4px 12px; font-size: 12px;">Save</button>
        <button type="button" class="btn btn-ghost" style="padding: 4px 8px; color: var(--danger);" onclick="this.closest('.custom-field-row')?.remove()">×</button>
      `;
        list.appendChild(row);

        // Show/hide options input when type changes to select
        const typeSelect = row.querySelector(
          ".cf-type-select",
        ) as HTMLSelectElement;
        const optionsInput = row.querySelector(
          ".cf-options-input",
        ) as HTMLInputElement;
        typeSelect?.addEventListener("change", () => {
          optionsInput.style.display =
            typeSelect.value === "select" ? "block" : "none";
        });

        row.querySelector("input")?.focus();

        // Attach save handler to new row
        row
          .querySelector(".custom-field-save")
          ?.addEventListener("click", async function () {
            const nameInput = row.querySelector("input") as HTMLInputElement;
            const typeSelect = row.querySelector(
              ".cf-type-select",
            ) as HTMLSelectElement;
            const optionsInput = row.querySelector(
              ".cf-options-input",
            ) as HTMLInputElement;
            const name = nameInput?.value?.trim();
            const type = typeSelect?.value || "text";
            if (!name) {
              nameInput?.focus();
              return;
            }

            // Build field definition with optional options for select type
            const fieldDef: { name: string; type: string; options?: string[] } =
              { name, type };
            if (type === "select" && optionsInput?.value?.trim()) {
              fieldDef.options = optionsInput.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
                .filter((v, i, a) => a.indexOf(v) === i);
            }

            try {
              const settingsRes = await fetch(
                (window.__ingress_path || "") + "/api/settings",
              );
              const settings = settingsRes.ok ? await settingsRes.json() : {};
              const existing = settings.custom_fields
                ? JSON.parse(settings.custom_fields)
                : [];
              existing.push(fieldDef);

              await fetch((window.__ingress_path || "") + "/api/settings", {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  key: "custom_fields",
                  value: JSON.stringify(existing),
                }),
              });

              nameInput.disabled = true;
              typeSelect.disabled = true;
              if (optionsInput) optionsInput.disabled = true;
              const saveBtn = row.querySelector(
                ".custom-field-save",
              ) as HTMLButtonElement;
              if (saveBtn) {
                saveBtn.textContent = "✓ Saved";
                saveBtn.disabled = true;
                saveBtn.style.color = "var(--success)";
              }
              showToast("settings.custom_field_saved");
            } catch {
              showToast("settings.failed_save_field", "error");
            }
          });
      });

    // AI provider custom URL toggle
    document
      .getElementById("ai-provider")
      ?.addEventListener("change", function () {
        const group = document.getElementById("ai-custom-url-group");
        if (group) {
          group.style.display =
            (this as HTMLSelectElement).value === "custom" ? "block" : "none";
        }
      });

    document.getElementById("save-ai")?.addEventListener("click", async () => {
      const provider = (
        document.getElementById("ai-provider") as HTMLSelectElement
      ).value;
      const customUrl = (
        document.getElementById("ai-custom-url") as HTMLInputElement
      ).value;

      const saveBtn = document.getElementById("save-ai") as HTMLButtonElement;
      if (!saveBtn) return;
      const origText = saveBtn.innerHTML;
      saveBtn.innerHTML = "💾 Saving...";
      saveBtn.disabled = true;

      await saveSetting("ai-provider", provider);
      localStorage.setItem("meitheal-ai-provider", provider);
      if (provider === "custom" || provider === "ollama") {
        await saveSetting("ai-custom-url", customUrl);
        localStorage.setItem("meitheal-ai-custom-url", customUrl);
      }

      saveBtn.innerHTML = origText;
      saveBtn.disabled = false;
      showToast("settings.ai_saved");
    });

    // ───── Webhook Save + Test ─────

    // ───── Agent Protocol Save ─────
    document
      .getElementById("save-agent-protocols")
      ?.addEventListener("click", async () => {
        const a2a =
          (document.getElementById("agent-a2a-enabled") as HTMLInputElement)
            ?.checked ?? true;
        const webmcp =
          (document.getElementById("agent-webmcp-enabled") as HTMLInputElement)
            ?.checked ?? false;
        const mcp =
          (document.getElementById("agent-mcp-enabled") as HTMLInputElement)
            ?.checked ?? true;

        const saveBtn = document.getElementById(
          "save-agent-protocols",
        ) as HTMLButtonElement;
        if (!saveBtn) return;
        const origText = saveBtn.innerHTML;
        saveBtn.innerHTML = "💾 Saving...";
        saveBtn.disabled = true;

        await saveSetting("agent-protocols-a2a-enabled", a2a);
        await saveSetting("agent-protocols-webmcp-enabled", webmcp);
        await saveSetting("agent-protocols-mcp-enabled", mcp);

        // Update status badge
        const statusEl = document.getElementById("agent-protocols-status");
        if (statusEl) {
          const anyEnabled = a2a || webmcp || mcp;
          statusEl.textContent = anyEnabled ? "Active" : "Disabled";
          statusEl.className = anyEnabled
            ? "badge badge-active"
            : "badge badge-pending";
        }

        saveBtn.innerHTML = origText;
        saveBtn.disabled = false;
        showToast("settings.agent_protocols_saved");
      });
    document
      .getElementById("save-webhook")
      ?.addEventListener("click", async () => {
        const endpoint = (
          document.getElementById("webhook-endpoint") as HTMLInputElement
        ).value;
        const secret = (
          document.getElementById("webhook-secret") as HTMLInputElement
        ).value;
        const format = (
          document.getElementById("webhook-format") as HTMLSelectElement
        ).value;

        if (!endpoint) {
          showToast("settings.webhook_required", "error");
          return;
        }

        const btn = document.getElementById(
          "save-webhook",
        ) as HTMLButtonElement;
        btn.textContent = "Saving...";
        btn.disabled = true;

        await saveSetting("webhook_endpoint", endpoint);
        if (secret) await saveSetting("webhook_secret", secret);
        await saveSetting("webhook_format", format);

        btn.textContent = "Save Webhook";
        btn.disabled = false;
        showToast("settings.webhook_saved");
      });

    document
      .getElementById("test-webhook")
      ?.addEventListener("click", async () => {
        const endpoint = (
          document.getElementById("webhook-endpoint") as HTMLInputElement
        ).value;
        if (!endpoint) {
          showToast("settings.webhook_enter_url", "error");
          return;
        }

        const btn = document.getElementById(
          "test-webhook",
        ) as HTMLButtonElement;
        btn.textContent = "Sending...";
        btn.disabled = true;

        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              eventType: "webhook.test",
              timestamp: new Date().toISOString(),
              payload: {
                message: "Test ping from Meitheal",
                source: "settings",
              },
            }),
          });
          showToast(
            res.ok
              ? `✅ Test sent — ${res.status}`
              : `⚠ Response: ${res.status}`,
            res.ok ? "success" : "error",
          );
        } catch (err) {
          showToast(
            `❌ Failed: ${err instanceof Error ? err.message : "Network error"}`,
            "error",
          );
        }

        btn.textContent = "Send Test";
        btn.disabled = false;
      });

    // ───── n8n Save (HA Addon / Auto mode) ─────
    document.getElementById("save-n8n")?.addEventListener("click", async () => {
      const webhookUrl =
        (document.getElementById("n8n-webhook-url") as HTMLInputElement)
          ?.value || "";

      const events: string[] = [];
      document.querySelectorAll(".n8n-event:checked").forEach((cb) => {
        events.push((cb as HTMLInputElement).value);
      });

      const btn = document.getElementById("save-n8n") as HTMLButtonElement;
      btn.textContent = "Saving...";
      btn.disabled = true;

      await saveSetting("n8n_mode", "ha_addon");
      if (webhookUrl) await saveSetting("n8n_webhook_url", webhookUrl);
      await saveSetting("n8n_events", events);

      const statusEl = document.getElementById("n8n-status");
      if (statusEl) {
        statusEl.textContent = "Configured";
        statusEl.className = "badge badge-active";
      }

      btn.textContent = "Save n8n Settings";
      btn.disabled = false;
      showToast("settings.n8n_saved");
    });

    // ───── Test Event Bus (fires meitheal_test on HA event bus) ─────
    document
      .getElementById("test-event-bus")
      ?.addEventListener("click", async () => {
        const btn = document.getElementById(
          "test-event-bus",
        ) as HTMLButtonElement;
        const resultDiv = document.getElementById("test-event-result");
        const msgSpan = document.getElementById("test-event-message");
        if (!btn) return;

        btn.textContent = "🔌 Sending...";
        btn.disabled = true;

        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/integrations/test-event",
            { method: "POST", headers: { "content-type": "application/json" } },
          );
          const data = await res.json();

          if (resultDiv && msgSpan) {
            resultDiv.style.display = "block";
            if (data.success) {
              resultDiv.className =
                "integration-callout integration-callout--success";
              msgSpan.textContent = `✅ ${data.hint}`;
            } else {
              resultDiv.className =
                "integration-callout integration-callout--warning";
              msgSpan.textContent = `⚠ ${data.error || data.hint || "Failed to send test event"}`;
            }
          }
        } catch (err) {
          if (resultDiv && msgSpan) {
            resultDiv.style.display = "block";
            resultDiv.className =
              "integration-callout integration-callout--warning";
            msgSpan.textContent = `❌ Network error: ${err instanceof Error ? err.message : "unknown"}`;
          }
        }

        btn.textContent = "🔌 Test Event Bus";
        btn.disabled = false;
      });

    // ───── Copy Node-RED example flows to clipboard ─────
    document
      .getElementById("copy-nodered-flows")
      ?.addEventListener("click", async () => {
        const btn = document.getElementById(
          "copy-nodered-flows",
        ) as HTMLButtonElement;
        if (!btn) return;

        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/integrations/nodered/flows",
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const flowJson = await res.text();
          await navigator.clipboard.writeText(flowJson);
          btn.textContent = "✅ Copied!";
          showToast(
            "Node-RED flows copied to clipboard — paste in Node-RED → Import",
          );
          setTimeout(() => {
            btn.textContent = "📋 Copy Flow JSON";
          }, 2000);
        } catch (err) {
          btn.textContent = "❌ Failed";
          showToast(
            `Failed to copy: ${err instanceof Error ? err.message : "error"}`,
            "error",
          );
          setTimeout(() => {
            btn.textContent = "📋 Copy Flow JSON";
          }, 2000);
        }
      });

    // ───── n8n Standalone Save ─────
    document
      .getElementById("save-n8n-standalone")
      ?.addEventListener("click", async () => {
        const webhookUrl = (
          document.getElementById("n8n-webhook-url") as HTMLInputElement
        ).value;
        const apiKey = (
          document.getElementById("n8n-api-key") as HTMLInputElement
        ).value;
        const secret = (
          document.getElementById("n8n-secret") as HTMLInputElement
        ).value;

        if (!webhookUrl) {
          showToast("settings.n8n_required", "error");
          return;
        }

        const events: string[] = [];
        document
          .querySelectorAll(".n8n-event-standalone:checked")
          .forEach((cb) => {
            events.push((cb as HTMLInputElement).value);
          });

        const btn = document.getElementById(
          "save-n8n-standalone",
        ) as HTMLButtonElement;
        btn.textContent = "Saving...";
        btn.disabled = true;

        await saveSetting("n8n_mode", "standalone");
        await saveSetting("n8n_webhook_url", webhookUrl);
        if (apiKey) await saveSetting("n8n_api_key", apiKey);
        if (secret) await saveSetting("n8n_signing_secret", secret);
        await saveSetting("n8n_events", events);

        const statusEl = document.getElementById("n8n-status");
        if (statusEl) {
          statusEl.textContent = "Configured";
          statusEl.className = "badge badge-active";
        }

        btn.textContent = "Save Standalone Settings";
        btn.disabled = false;
        showToast("settings.n8n_saved");
      });

    // ───── Grocy Save ─────
    // Auto-key generation button
    document
      .getElementById("grocy-auto-key")
      ?.addEventListener("click", async () => {
        const btn = document.getElementById(
          "grocy-auto-key",
        ) as HTMLButtonElement;
        const origText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "…";

        try {
          const urlInput = document.getElementById(
            "grocy-url",
          ) as HTMLInputElement;
          const keyInput = document.getElementById(
            "grocy-key",
          ) as HTMLInputElement;
          const body: Record<string, string> = {};
          if (urlInput?.value?.trim()) body.url = urlInput.value.trim();

          const res = await fetch(
            (window.__ingress_path || "") + "/api/grocy/auto-key",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          const data = await res.json();

          if (data.ok) {
            if (keyInput) keyInput.placeholder = data.apiKey || "••••";
            if (urlInput && data.url) urlInput.value = data.url;
            showToast("API key generated and saved", "success");
          } else {
            showToast(data.error || "Auto-key failed", "error");
          }
        } catch {
          showToast("Failed to auto-generate key", "error");
        } finally {
          btn.disabled = false;
          btn.textContent = origText;
        }
      });

    document
      .getElementById("save-grocy")
      ?.addEventListener("click", async () => {
        const url = (document.getElementById("grocy-url") as HTMLInputElement)
          .value;
        const key = (document.getElementById("grocy-key") as HTMLInputElement)
          .value;
        const syncMode = (
          document.getElementById("grocy-sync-mode") as HTMLSelectElement
        ).value;
        const syncInterval = (
          document.getElementById("grocy-sync-interval") as HTMLSelectElement
        ).value;

        // If auto-detected, the URL field may be visible but should not be required
        const grocyAutoDetected = document.getElementById("grocy-auto-info");
        const isAutoDetected =
          grocyAutoDetected && grocyAutoDetected.style.display !== "none";
        if (!url && !isAutoDetected) {
          showToast("settings.grocy_required", "error");
          const urlInput = document.getElementById("grocy-url");
          urlInput?.classList.add("form-input--error");
          urlInput?.addEventListener(
            "input",
            () => urlInput.classList.remove("form-input--error"),
            { once: true },
          );
          return;
        }

        // Basic URL validation
        if (url) {
          try {
            new URL(url);
          } catch {
            showToast("Please enter a valid URL", "error");
            const urlInput = document.getElementById("grocy-url");
            urlInput?.classList.add("form-input--error");
            urlInput?.addEventListener(
              "input",
              () => urlInput.classList.remove("form-input--error"),
              { once: true },
            );
            return;
          }
        }

        const btn = document.getElementById("save-grocy") as HTMLButtonElement;
        btn.textContent = "Saving...";
        btn.disabled = true;

        try {
          const payload: Record<string, unknown> = {
            grocy_sync_mode: syncMode,
            grocy_sync_interval: Number(syncInterval),
            grocy_sync_enabled: true,
          };
          if (url) payload.grocy_url = url;
          if (key) payload.grocy_api_key = key;

          const res = await fetch(
            (window.__ingress_path || "") + "/api/grocy/settings",
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            },
          );
          const data = await res.json();

          if (data.ok) {
            const statusEl = document.getElementById("grocy-status");
            if (statusEl) {
              statusEl.textContent = "Configured";
              statusEl.className = "badge badge-active";
            }

            // Show sync now button
            const syncBtn = document.getElementById("sync-grocy-now");
            if (syncBtn) syncBtn.style.display = "";

            showToast("Grocy settings saved");
          } else {
            showToast(data.error || "Failed to save Grocy settings", "error");
          }
        } catch (err) {
          showToast("Failed to save Grocy settings", "error");
        }

        btn.textContent = "Save Grocy Settings";
        btn.disabled = false;
      });

    // ───── Grocy Test Connection ─────
    document
      .getElementById("test-grocy")
      ?.addEventListener("click", async () => {
        const url = (document.getElementById("grocy-url") as HTMLInputElement)
          .value;
        const key = (document.getElementById("grocy-key") as HTMLInputElement)
          .value;
        const resultEl = document.getElementById("grocy-test-result");
        const btn = document.getElementById("test-grocy") as HTMLButtonElement;

        // When auto-detected, use the auto-detected URL and don't require manual API key
        const grocyAutoDetected = document.getElementById("grocy-auto-info");
        const isAutoDetected =
          grocyAutoDetected && grocyAutoDetected.style.display !== "none";

        // For manual config, both URL and key are required
        // For auto-detected, we can test with just the Supervisor ingress
        if (!isAutoDetected && (!url || !key)) {
          if (resultEl) {
            resultEl.style.display = "block";
            resultEl.className =
              "integration-callout integration-callout--warning";
            resultEl.innerHTML = "<strong>⚠ URL and API key required</strong>";
          }
          return;
        }

        btn.textContent = "Testing...";
        btn.disabled = true;

        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/grocy/test",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                url: url || undefined,
                api_key: key || undefined,
                auto_detected: isAutoDetected || false,
              }),
            },
          );
          const data = await res.json();

          if (resultEl) {
            resultEl.style.display = "block";
            if (data.ok) {
              resultEl.className =
                "integration-callout integration-callout--success";
              resultEl.innerHTML = `<strong>✓ Connected to Grocy ${data.version}</strong>
                <div class="integration-callout__detail">
                  ${data.counts.chores} chore${data.counts.chores !== 1 ? "s" : ""} ·
                  ${data.counts.tasks} task${data.counts.tasks !== 1 ? "s" : ""} ·
                  ${data.counts.shoppingItems} shopping item${data.counts.shoppingItems !== 1 ? "s" : ""}
                </div>`;
            } else {
              resultEl.className =
                "integration-callout integration-callout--warning";
              resultEl.innerHTML = `<strong>✗ Connection failed</strong>
                <div class="integration-callout__detail">${data.error || "Unknown error"}</div>`;
            }
          }
        } catch (err) {
          if (resultEl) {
            resultEl.style.display = "block";
            resultEl.className =
              "integration-callout integration-callout--warning";
            resultEl.innerHTML = `<strong>✗ Network error</strong>
              <div class="integration-callout__detail">${err instanceof Error ? err.message : "Unknown"}</div>`;
          }
        }

        btn.textContent = "Test Connection";
        btn.disabled = false;
      });

    // ───── Grocy Sync Now ─────
    document
      .getElementById("sync-grocy-now")
      ?.addEventListener("click", async () => {
        const btn = document.getElementById(
          "sync-grocy-now",
        ) as HTMLButtonElement;
        btn.textContent = "Syncing...";
        btn.disabled = true;

        try {
          const syncMode = (
            document.getElementById("grocy-sync-mode") as HTMLSelectElement
          ).value;
          const syncInterval = (
            document.getElementById("grocy-sync-interval") as HTMLSelectElement
          ).value;

          const res = await fetch(
            (window.__ingress_path || "") + "/api/grocy/sync",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "sync",
                sync_mode: syncMode,
                interval_ms: Number(syncInterval),
              }),
            },
          );
          const data = await res.json();

          if (data.ok) {
            showToast(data.message || "Grocy sync complete");

            // Update last synced
            const lastSyncedEl = document.getElementById("grocy-last-synced");
            const itemCountEl = document.getElementById("grocy-item-count");
            const syncInfoEl = document.getElementById("grocy-sync-info");

            if (syncInfoEl) syncInfoEl.style.display = "";
            if (lastSyncedEl) {
              lastSyncedEl.textContent = `Last synced: ${new Date().toLocaleTimeString()}`;
            }
            if (itemCountEl && data.status) {
              const total =
                (data.status.choreCount || 0) +
                (data.status.taskCount || 0) +
                (data.status.shoppingCount || 0);
              itemCountEl.textContent = `${total} item${total !== 1 ? "s" : ""}`;
            }

            // Update badge
            const statusEl = document.getElementById("grocy-status");
            if (statusEl) {
              const total =
                (data.chores || 0) + (data.tasks || 0) + (data.shopping || 0);
              statusEl.textContent = total > 0 ? `Active (${total})` : "Active";
              statusEl.className = "badge badge-active";
            }
          } else {
            showToast(data.error || "Grocy sync failed", "error");
          }
        } catch (err) {
          showToast("Grocy sync failed", "error");
        }

        btn.textContent = "Sync Now";
        btn.disabled = false;
      });

    // ───── Grocy Hydrate on Load ─────
    (async function hydrateGrocyStatus() {
      try {
        const res = await fetch(
          (window.__ingress_path || "") + "/api/grocy/settings",
        );
        if (!res.ok) return;
        const data = await res.json();
        const s = data.settings || {};

        // Hydrate URL (if saved)
        if (s.grocy_url) {
          (document.getElementById("grocy-url") as HTMLInputElement).value =
            s.grocy_url;
        }

        // Hydrate API key masked indicator
        if (s.grocy_api_key_set) {
          (
            document.getElementById("grocy-key") as HTMLInputElement
          ).placeholder = s.grocy_api_key_masked || "••••";
        }

        // Hydrate sync mode
        if (s.grocy_sync_mode) {
          (
            document.getElementById("grocy-sync-mode") as HTMLSelectElement
          ).value = s.grocy_sync_mode;
        }

        // Hydrate sync interval
        if (s.grocy_sync_interval !== undefined) {
          (
            document.getElementById("grocy-sync-interval") as HTMLSelectElement
          ).value = String(s.grocy_sync_interval);
        }

        // Update status badge if configured
        if (s.grocy_url || s.grocy_api_key_set) {
          const statusEl = document.getElementById("grocy-status");
          if (statusEl) {
            statusEl.textContent = "Configured";
            statusEl.className = "badge badge-active";
          }

          // Show sync now button
          const syncBtn = document.getElementById("sync-grocy-now");
          if (syncBtn) syncBtn.style.display = "";

          // Show Open Grocy link with the configured URL
          const openLink = document.getElementById(
            "open-grocy-link",
          ) as HTMLAnchorElement | null;
          if (openLink && s.grocy_url) {
            openLink.href = String(s.grocy_url);
            openLink.style.display = "";
          }
        }

        // Hydrate sync status
        const syncRes = await fetch(
          (window.__ingress_path || "") + "/api/grocy/sync",
        );
        if (syncRes.ok) {
          const syncData = await syncRes.json();
          const sync = syncData.sync;

          if (sync?.active) {
            const statusEl = document.getElementById("grocy-status");
            if (statusEl) {
              statusEl.textContent =
                sync.itemCount > 0 ? `Active (${sync.itemCount})` : "Active";
              statusEl.className = "badge badge-active";
            }
          }

          if (sync?.lastSyncAt) {
            const syncInfoEl = document.getElementById("grocy-sync-info");
            const lastSyncedEl = document.getElementById("grocy-last-synced");
            const itemCountEl = document.getElementById("grocy-item-count");

            if (syncInfoEl) syncInfoEl.style.display = "";
            if (lastSyncedEl) {
              const ts = new Date(sync.lastSyncAt).toLocaleTimeString();
              if (sync.lastSyncError) {
                lastSyncedEl.textContent = `⚠ ${sync.lastSyncError} — last sync: ${ts}`;
                lastSyncedEl.style.color = "var(--danger, #e74c3c)";
                // Turn badge to error state
                const statusEl = document.getElementById("grocy-status");
                if (statusEl) {
                  statusEl.textContent = "Sync Error";
                  statusEl.className = "badge badge-error";
                }
              } else {
                lastSyncedEl.textContent = `Last synced: ${ts}`;
                lastSyncedEl.style.color = "";
              }
            }
            if (itemCountEl) {
              itemCountEl.textContent = `${sync.itemCount} item${sync.itemCount !== 1 ? "s" : ""}`;
            }
          }
        }
      } catch {
        /* silently fail — settings page should always render */
      }
    })();

    // ───── Calendar Save + Sync ─────
    // Hydrate calendar status on tab open
    async function hydrateCalendarStatus() {
      const statusEl = document.getElementById("cal-status");
      const autoInfo = document.getElementById("cal-auto-info");
      const autoEntity = document.getElementById("cal-auto-entity");
      const entitiesList = document.getElementById("cal-entities-list");
      const entitiesContainer = document.getElementById(
        "cal-entities-container",
      );

      try {
        const res = await fetch(
          (window.__ingress_path || "") + "/api/ha/calendars",
        );
        if (!res.ok) throw new Error("API error");
        const data = (await res.json()) as {
          calendars?: {
            entity_id: string;
            friendly_name: string;
            state: string;
          }[];
          sync?: {
            active: boolean;
            entityId: string | null;
            writeBack: boolean;
            lastSyncAt: number | null;
            lastSyncEventCount: number | null;
            lastSyncError: string | null;
          };
        };

        const calendars = data.calendars ?? [];
        const sync = data.sync ?? {
          active: false,
          entityId: null,
          writeBack: false,
          lastSyncAt: null,
          lastSyncEventCount: null,
          lastSyncError: null,
        };

        // Update badge
        if (statusEl) {
          if (sync.active) {
            statusEl.textContent = "Syncing";
            statusEl.className = "badge badge-active";
          } else if (calendars.length > 0) {
            statusEl.textContent = `${calendars.length} found`;
            statusEl.className = "badge badge-active";
          } else {
            statusEl.textContent = "No calendars";
            statusEl.className = "badge badge-pending";
          }
        }

        // Show last sync info
        const lastSynced = document.getElementById("cal-last-synced");
        if (lastSynced && sync.lastSyncAt) {
          const ts = new Date(sync.lastSyncAt).toLocaleTimeString();
          const evtCount = sync.lastSyncEventCount ?? 0;
          if (sync.lastSyncError) {
            lastSynced.textContent = `Last sync: ${ts} — ⚠ ${sync.lastSyncError}`;
            lastSynced.style.color = "var(--amber-500, #f59e0b)";
          } else {
            lastSynced.textContent = `Last synced: ${ts} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`;
            lastSynced.style.color = "var(--text-muted)";
          }
        }

        // Show auto-sync callout if sync is active
        if (sync.active && autoInfo) {
          autoInfo.style.display = "block";
          if (autoEntity && sync.entityId) {
            autoEntity.textContent = sync.entityId;
          }
        }

        // Show detected entities as toggle cards
        if (calendars.length > 0 && entitiesList && entitiesContainer) {
          entitiesList.style.display = "block";

          // Get previously saved entities to pre-check
          let savedEntities: string[] = [];
          let savedSyncModes: Record<string, string> = {};
          let savedGlobalMode = "bidirectional";
          try {
            const settingsRes = await fetch(
              (window.__ingress_path || "") + "/api/settings",
            );
            // GET /api/settings returns a flat key-value object (not wrapped in .settings)
            const s = (await settingsRes.json()) as Record<string, unknown>;
            const raw =
              s.calendar_entities ?? s.calendar_entity ?? s.cal_entity;
            if (Array.isArray(raw)) {
              savedEntities = raw as string[];
            } else if (typeof raw === "string") {
              try {
                const parsed = JSON.parse(raw);
                savedEntities = Array.isArray(parsed)
                  ? parsed
                  : parsed
                    ? [parsed]
                    : [];
              } catch {
                savedEntities = raw ? [raw] : [];
              }
            }
            // Restore per-entity sync modes
            if (s.calendar_sync_modes) {
              try {
                const parsed =
                  typeof s.calendar_sync_modes === "string"
                    ? JSON.parse(s.calendar_sync_modes as string)
                    : s.calendar_sync_modes;
                if (parsed && typeof parsed === "object")
                  savedSyncModes = parsed as Record<string, string>;
              } catch {
                /* invalid JSON */
              }
            }
            if (typeof s.calendar_sync_mode === "string") {
              savedGlobalMode = s.calendar_sync_mode;
            }
          } catch {
            /* ignore */
          }

          // Restore global sync direction dropdown
          const dirSelect = document.getElementById(
            "cal-sync-direction",
          ) as HTMLSelectElement | null;
          if (dirSelect && savedGlobalMode) {
            dirSelect.value = savedGlobalMode;
          }

          entitiesContainer.innerHTML = calendars
            .map(
              (c: {
                entity_id: string;
                friendly_name: string;
                state: string;
              }) => {
                const isEnabled = savedEntities.includes(c.entity_id);
                const stateLabel =
                  c.state === "off" ? "no active event" : c.state;
                const entityMode =
                  savedSyncModes[c.entity_id] ?? savedGlobalMode;
                return `<div class="cal-toggle-card${isEnabled ? " cal-toggle-card--active" : ""}" data-entity="${c.entity_id}">
                  <div class="cal-toggle-card__info">
                    <span class="cal-toggle-card__name">${c.friendly_name}</span>
                    <span class="cal-toggle-card__entity">${c.entity_id}</span>
                    <div class="cal-toggle-card__direction"${!isEnabled ? ' style="display:none"' : ""}>
                      <select class="cal-direction-select" data-entity-dir="${c.entity_id}" aria-label="Sync direction for ${c.friendly_name}">
                        <option value="bidirectional"${entityMode === "bidirectional" ? " selected" : ""}>↔ Bidirectional</option>
                        <option value="import"${entityMode === "import" ? " selected" : ""}>↓ Import only</option>
                        <option value="export"${entityMode === "export" ? " selected" : ""}>↑ Export only</option>
                      </select>
                    </div>
                    <span class="cal-toggle-card__state">${stateLabel}</span>
                  </div>
                  <label class="toggle-label">
                    <input type="checkbox" class="cal-entity-toggle" value="${c.entity_id}" ${isEnabled ? "checked" : ""} />
                    <span class="toggle-slider"></span>
                  </label>
                </div>`;
              },
            )
            .join("");

          // Count badge updater — reflects X of Y enabled
          function updateCalCountBadge() {
            const badge = document.getElementById("cal-count-badge");
            const toggles =
              document.querySelectorAll<HTMLInputElement>(".cal-entity-toggle");
            const total = toggles.length;
            const enabled = Array.from(toggles).filter((t) => t.checked).length;
            if (badge) {
              badge.textContent = `${enabled} of ${total} enabled`;
              badge.style.color =
                enabled > 0 ? "var(--accent)" : "var(--text-muted)";
              badge.style.borderColor =
                enabled > 0
                  ? "color-mix(in srgb, var(--accent) 30%, transparent)"
                  : "var(--border)";
            }
          }
          // Expose for manual add handler
          (window as unknown as Record<string, unknown>).__updateCalCount =
            updateCalCountBadge;

          // Toggle card active state on change + make entire card clickable
          entitiesContainer
            .querySelectorAll<HTMLInputElement>(".cal-entity-toggle")
            .forEach((cb) => {
              cb.addEventListener("change", () => {
                const card = cb.closest(".cal-toggle-card");
                if (card) {
                  card.classList.toggle("cal-toggle-card--active", cb.checked);
                  // Show/hide direction selector when toggling
                  const dirDiv = card.querySelector<HTMLElement>(
                    ".cal-toggle-card__direction",
                  );
                  if (dirDiv) dirDiv.style.display = cb.checked ? "" : "none";
                }
                updateCalCountBadge();
              });
            });

          // Prevent direction select clicks from toggling the card checkbox
          entitiesContainer
            .querySelectorAll<HTMLSelectElement>(".cal-direction-select")
            .forEach((sel) => {
              sel.addEventListener("click", (e) => e.stopPropagation());
              sel.addEventListener("mousedown", (e) => e.stopPropagation());
            });

          // Click anywhere on card toggles the checkbox (since outer is now <div> not <label>)
          entitiesContainer
            .querySelectorAll<HTMLElement>(".cal-toggle-card")
            .forEach((card) => {
              card.addEventListener("click", (e) => {
                // Don't double-toggle if the click was on the toggle itself or direction select
                const target = e.target as HTMLElement;
                if (
                  target.closest(".toggle-label") ||
                  target.closest(".cal-direction-select")
                )
                  return;
                const cb =
                  card.querySelector<HTMLInputElement>(".cal-entity-toggle");
                if (cb) {
                  cb.checked = !cb.checked;
                  cb.dispatchEvent(new Event("change", { bubbles: true }));
                }
              });
              card.style.cursor = "pointer";
            });

          // Enable All / Disable All handlers
          document
            .getElementById("cal-enable-all")
            ?.addEventListener("click", () => {
              entitiesContainer
                .querySelectorAll<HTMLInputElement>(".cal-entity-toggle")
                .forEach((cb) => {
                  cb.checked = true;
                  const card = cb.closest(".cal-toggle-card");
                  card?.classList.add("cal-toggle-card--active");
                  // Show direction selector when enabling
                  const dirDiv = card?.querySelector<HTMLElement>(
                    ".cal-toggle-card__direction",
                  );
                  if (dirDiv) dirDiv.style.display = "";
                });
              updateCalCountBadge();
            });
          document
            .getElementById("cal-disable-all")
            ?.addEventListener("click", () => {
              entitiesContainer
                .querySelectorAll<HTMLInputElement>(".cal-entity-toggle")
                .forEach((cb) => {
                  cb.checked = false;
                  const card = cb.closest(".cal-toggle-card");
                  card?.classList.remove("cal-toggle-card--active");
                  // Hide direction selector when disabling
                  const dirDiv = card?.querySelector<HTMLElement>(
                    ".cal-toggle-card__direction",
                  );
                  if (dirDiv) dirDiv.style.display = "none";
                });
              updateCalCountBadge();
            });

          // Global direction cascade — when default changes, update all per-card selectors
          // that still match the old default (i.e. haven't been individually overridden)
          const globalDirSel = document.getElementById(
            "cal-sync-direction",
          ) as HTMLSelectElement | null;
          if (globalDirSel) {
            let previousGlobal = globalDirSel.value;
            globalDirSel.addEventListener("change", () => {
              const newGlobal = globalDirSel.value;
              entitiesContainer
                .querySelectorAll<HTMLSelectElement>(".cal-direction-select")
                .forEach((sel) => {
                  // Only cascade to cards that haven't been manually overridden
                  if (sel.value === previousGlobal) {
                    sel.value = newGlobal;
                  }
                });
              previousGlobal = newGlobal;
            });
          }

          // Auto-enable all if none are saved and there's only one calendar
          if (savedEntities.length === 0 && calendars.length === 1) {
            const firstToggle =
              entitiesContainer.querySelector<HTMLInputElement>(
                ".cal-entity-toggle",
              );
            if (firstToggle) {
              firstToggle.checked = true;
              firstToggle
                .closest(".cal-toggle-card")
                ?.classList.add("cal-toggle-card--active");
            }
          }

          // Update count badge after initial render
          updateCalCountBadge();
        } else {
          // No calendars detected — show empty state
          if (entitiesList) {
            entitiesList.style.display = "block";
            const emptyState = document.getElementById("cal-no-entities");
            if (emptyState) emptyState.style.display = "flex";
          }
        }
      } catch {
        if (statusEl) {
          statusEl.textContent = "Unavailable";
          statusEl.className = "badge badge-pending";
        }
      }
    }
    hydrateCalendarStatus();

    // Manual "Add Calendar" button handler
    document.getElementById("cal-add-manual")?.addEventListener("click", () => {
      const input = document.getElementById(
        "cal-entity-manual",
      ) as HTMLInputElement | null;
      const container = document.getElementById("cal-entities-container");
      const entitiesList = document.getElementById("cal-entities-list");
      if (!input || !container) return;
      const entityId = input.value.trim();
      if (!entityId || !entityId.startsWith("calendar.")) {
        input.style.borderColor = "var(--red-500, #ef4444)";
        setTimeout(() => {
          input.style.borderColor = "";
        }, 1500);
        return;
      }
      // Check for duplicates
      if (container.querySelector(`[data-entity="${entityId}"]`)) {
        input.value = "";
        return;
      }
      // Ensure the list container is visible
      if (entitiesList) entitiesList.style.display = "block";
      // Add new toggle card
      const card = document.createElement("div");
      card.className = "cal-toggle-card cal-toggle-card--active";
      card.dataset.entity = entityId;
      card.style.cursor = "pointer";
      card.innerHTML = `
        <div class="cal-toggle-card__info">
          <span class="cal-toggle-card__name"></span>
          <span class="cal-toggle-card__entity"></span>
          <div class="cal-toggle-card__direction">
            <select class="cal-direction-select">
              <option value="bidirectional" selected>↔ Bidirectional</option>
              <option value="import">↓ Import only</option>
              <option value="export">↑ Export only</option>
            </select>
          </div>
          <span class="cal-toggle-card__state">manually added</span>
        </div>
        <label class="toggle-label">
          <input type="checkbox" class="cal-entity-toggle" checked />
          <span class="toggle-slider"></span>
        </label>`;
      const cardName = card.querySelector<HTMLElement>(".cal-toggle-card__name");
      if (cardName) cardName.textContent = entityId;
      const cardEntity = card.querySelector<HTMLElement>(".cal-toggle-card__entity");
      if (cardEntity) cardEntity.textContent = entityId;
      const directionSelect = card.querySelector<HTMLSelectElement>(".cal-direction-select");
      if (directionSelect) {
        directionSelect.dataset.entityDir = entityId;
        directionSelect.setAttribute("aria-label", `Sync direction for ${entityId}`);
      }
      const entityToggle = card.querySelector<HTMLInputElement>(".cal-entity-toggle");
      if (entityToggle) entityToggle.value = entityId;
      card
        .querySelector<HTMLInputElement>(".cal-entity-toggle")
        ?.addEventListener("change", function () {
          card.classList.toggle("cal-toggle-card--active", this.checked);
          // Update count badge
          const updater = (window as unknown as Record<string, unknown>)
            .__updateCalCount;
          if (typeof updater === "function") (updater as () => void)();
        });
      // Click anywhere on card toggles the checkbox
      card.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".toggle-label")) return;
        const cb = card.querySelector<HTMLInputElement>(".cal-entity-toggle");
        if (cb) {
          cb.checked = !cb.checked;
          cb.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
      container.appendChild(card);
      // Hide empty state if visible
      const emptyState = document.getElementById("cal-no-entities");
      if (emptyState) emptyState.style.display = "none";
      // Update count badge
      const updater = (window as unknown as Record<string, unknown>)
        .__updateCalCount;
      if (typeof updater === "function") (updater as () => void)();
      input.value = "";
    });

    /** Read entity value from EntitySelector (handles select OR manual input) */
    function readEntityValue(id: string): string {
      const select = document.getElementById(id) as HTMLSelectElement | null;
      const manual = document.getElementById(
        `${id}-manual`,
      ) as HTMLInputElement | null;
      // If the select is visible and has a value, use it
      if (select && select.style.display !== "none" && select.value)
        return select.value;
      // Otherwise use the manual input
      if (manual && manual.value) return manual.value;
      // Fall back to select value even if hidden
      return select?.value || manual?.value || "";
    }

    document
      .getElementById("caldav-test-btn")
      ?.addEventListener("click", async () => {
        const url = (document.getElementById("caldav-url") as HTMLInputElement)
          .value;
        const username = (
          document.getElementById("caldav-username") as HTMLInputElement
        ).value;
        const password = (
          document.getElementById("caldav-password") as HTMLInputElement
        ).value;
        const resultEl = document.getElementById("caldav-test-result");
        const btn = document.getElementById(
          "caldav-test-btn",
        ) as HTMLButtonElement;

        if (!url || !username || !password) {
          if (resultEl) {
            resultEl.textContent = "URL, username, and password required";
            resultEl.style.color = "var(--color-error)";
          }
          return;
        }

        btn.textContent = "Testing...";
        btn.disabled = true;
        if (resultEl) {
          resultEl.textContent = "";
          resultEl.style.color = "";
        }

        try {
          const res = await fetch(
            (window.__ingress_path || "") +
              "/api/integrations/calendar/caldav-credentials",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "test", url, username, password }),
            },
          );
          const data = await res.json();
          if (resultEl) {
            resultEl.textContent = data.ok
              ? data.message
              : `❌ ${data.message || data.error}`;
            resultEl.style.color = data.ok
              ? "var(--color-success)"
              : "var(--color-error)";
          }
        } catch (err) {
          if (resultEl) {
            resultEl.textContent = "❌ Request failed";
            resultEl.style.color = "var(--color-error)";
          }
        } finally {
          btn.textContent = "Test Connection";
          btn.disabled = false;
        }
      });

    document.getElementById("save-cal")?.addEventListener("click", async () => {
      // Collect enabled calendar entities from toggle cards
      const enabledEntities: string[] = [];
      document
        .querySelectorAll<HTMLInputElement>(".cal-entity-toggle:checked")
        .forEach((cb) => {
          enabledEntities.push(cb.value);
        });

      // Collect per-entity sync directions
      const syncModes: Record<string, string> = {};
      document
        .querySelectorAll<HTMLSelectElement>(".cal-direction-select")
        .forEach((sel) => {
          const entityId = sel.dataset.entityDir;
          if (entityId && enabledEntities.includes(entityId)) {
            syncModes[entityId] = sel.value;
          }
        });

      const globalMode =
        (document.getElementById("cal-sync-direction") as HTMLSelectElement)
          ?.value ?? "bidirectional";

      const caldavUrl = (
        document.getElementById("caldav-url") as HTMLInputElement
      ).value;
      const caldavUsername = (
        document.getElementById("caldav-username") as HTMLInputElement
      ).value;
      const caldavPassword = (
        document.getElementById("caldav-password") as HTMLInputElement
      ).value;
      const writeBack =
        (document.getElementById("cal-write-back") as HTMLInputElement)
          ?.checked ?? false;
      const intervalMs = Number(
        (document.getElementById("cal-sync-interval") as HTMLSelectElement)
          ?.value ?? "300000",
      );

      const btn = document.getElementById("save-cal") as HTMLButtonElement;
      btn.textContent = "Saving...";
      btn.disabled = true;

      // Save array directly — saveSetting already JSON.stringifies server-side
      await saveSetting("calendar_entities", enabledEntities);
      // Keep legacy key for backward compat (first enabled entity)
      await saveSetting("calendar_entity", enabledEntities[0] ?? "");
      await saveSetting(
        "calendar_sync_enabled",
        enabledEntities.length > 0 ? "true" : "false",
      );
      await saveSetting("calendar_write_back", writeBack);
      await saveSetting("calendar_sync_interval_ms", String(intervalMs));
      // Persist sync direction settings
      await saveSetting("calendar_sync_mode", globalMode);
      await saveSetting("calendar_sync_modes", syncModes);

      if (caldavUrl && caldavUsername && caldavPassword) {
        try {
          await fetch(
            (window.__ingress_path || "") +
              "/api/integrations/calendar/caldav-credentials",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "save",
                url: caldavUrl,
                username: caldavUsername,
                password: caldavPassword,
              }),
            },
          );
        } catch (err) {
          console.error("Failed to save CalDAV credentials", err);
        }
      } else if (caldavUrl && !caldavUsername && !caldavPassword) {
        await saveSetting("caldav_url", caldavUrl); // Legacy/unauthenticated
      }

      // Enable/disable calendar sync via API
      if (enabledEntities.length > 0) {
        try {
          await fetch(
            (window.__ingress_path || "") + "/api/integrations/calendar/sync",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "enable",
                entity_id: enabledEntities[0],
                entities: enabledEntities,
                write_back: writeBack,
                interval_ms: intervalMs,
                sync_mode: globalMode,
                sync_modes: syncModes,
              }),
            },
          );
        } catch {
          /* logged server-side */
        }
      } else {
        try {
          await fetch(
            (window.__ingress_path || "") + "/api/integrations/calendar/sync",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "disable" }),
            },
          );
        } catch {
          /* logged server-side */
        }
      }

      // Update status badge
      const statusEl = document.getElementById("cal-status");
      if (statusEl) {
        statusEl.textContent =
          enabledEntities.length > 0
            ? `${enabledEntities.length} syncing`
            : "Disabled";
        statusEl.className =
          enabledEntities.length > 0
            ? "badge badge-active"
            : "badge badge-pending";
      }

      btn.textContent = "Save Calendar Settings";
      btn.disabled = false;
      showToast("settings.calendar_saved");
      // Update the count badge directly — dom already reflects correct state
      const updater = (window as unknown as Record<string, unknown>)
        .__updateCalCount;
      if (typeof updater === "function") (updater as () => void)();
    });

    document.getElementById("test-cal")?.addEventListener("click", async () => {
      const btn = document.getElementById("test-cal") as HTMLButtonElement;
      const resultEl = document.getElementById("cal-sync-result");
      btn.textContent = "Syncing...";
      btn.disabled = true;

      try {
        const res = await fetch(
          (window.__ingress_path || "") + "/api/integrations/calendar/sync",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "sync" }),
          },
        );
        const data = (await res.json()) as {
          ok: boolean;
          message?: string;
          created?: number;
          updated?: number;
          total?: number;
        };
        if (resultEl) resultEl.textContent = data.message ?? "Sync triggered";
        showToast(
          data.ok
            ? `✅ ${data.message ?? "Calendar sync triggered"}`
            : "❌ Calendar sync failed",
          data.ok ? "success" : "error",
        );
        // Update last-synced timestamp
        if (data.ok) {
          const lastSynced = document.getElementById("cal-last-synced");
          if (lastSynced) {
            const evtCount = data.total ?? 0;
            lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()} — ${evtCount} event${evtCount !== 1 ? "s" : ""}`;
            lastSynced.style.color = "var(--text-muted)";
          }
        }
      } catch {
        if (resultEl) resultEl.textContent = "Sync failed";
        showToast("❌ Calendar sync failed", "error");
      }

      btn.textContent = "Sync Now";
      btn.disabled = false;
      // Clear result after 5s
      setTimeout(() => {
        if (resultEl) resultEl.textContent = "";
      }, 5000);
    });

    // ───── Todo Sync Save + Hydrate + Sync ─────

    /** Update the todo count badge */
    function updateTodoCount() {
      const badge = document.getElementById("todo-count-badge");
      if (!badge) return;
      const all = document.querySelectorAll<HTMLInputElement>(
        "#todo-entities-container .todo-entity-toggle",
      );
      const enabled = Array.from(all).filter((cb) => cb.checked).length;
      badge.textContent = `${enabled} of ${all.length} enabled`;
    }
    (window as unknown as Record<string, unknown>).__updateTodoCount =
      updateTodoCount;

    async function hydrateTodoStatus() {
      const statusEl = document.getElementById("todo-status");
      const autoInfo = document.getElementById("todo-auto-info");
      const autoEntities = document.getElementById("todo-auto-entities");
      const entitiesList = document.getElementById("todo-entities-list");
      const entitiesContainer = document.getElementById(
        "todo-entities-container",
      );
      const noEntities = document.getElementById("todo-no-entities");
      const enabledCb = document.getElementById(
        "todo-enabled",
      ) as HTMLInputElement | null;
      const enabledLabel = document.getElementById("todo-enabled-label");

      try {
        const res = await fetch((window.__ingress_path || "") + "/api/todo");
        if (!res.ok) throw new Error("API error");
        const data = (await res.json()) as {
          ok: boolean;
          entities?: {
            entity_id: string;
            friendly_name: string;
            state: string;
            sync: {
              active: boolean;
              direction: string;
              lastSyncAt: number | null;
              itemCount: number;
            } | null;
          }[];
        };

        const entities = data.entities ?? [];

        // Load saved enabled entities from settings
        let savedEnabled: string[] = [];
        try {
          const settingsRes = await fetch(
            (window.__ingress_path || "") + "/api/settings",
          );
          const settings = await settingsRes.json();
          if (settings.todo_entities) {
            savedEnabled = Array.isArray(settings.todo_entities)
              ? settings.todo_entities
              : [settings.todo_entities];
          } else if (settings.todo_entity) {
            savedEnabled = [settings.todo_entity];
          }
        } catch {
          /* use defaults */
        }

        // Show detected entities callout
        if (entities.length > 0 && autoInfo && autoEntities) {
          autoInfo.style.display = "block";
          autoEntities.innerHTML = entities
            .map(
              (e) =>
                `• <code style="font-family: 'JetBrains Mono', monospace; font-size: 11px;">${e.entity_id}</code> (${e.friendly_name})`,
            )
            .join("<br>");
        }

        // Render toggle cards
        if (entitiesList && entitiesContainer) {
          entitiesList.style.display = "block";

          if (entities.length === 0) {
            entitiesContainer.innerHTML = "";
            if (noEntities) noEntities.style.display = "flex";
          } else {
            if (noEntities) noEntities.style.display = "none";
            // Auto-enable first entity if nothing is saved
            const autoSelect = savedEnabled.length === 0 && entities.length > 0;

            entitiesContainer.innerHTML = entities
              .map((e) => {
                const isEnabled = autoSelect
                  ? e === entities[0]
                  : savedEnabled.includes(e.entity_id);
                const stateLabel = e.sync?.active
                  ? `${e.state} · syncing${e.sync.itemCount ? ` · ${e.sync.itemCount} items` : ""}`
                  : e.state;
                return `<div class="cal-toggle-card${isEnabled ? " cal-toggle-card--active" : ""}" data-entity="${e.entity_id}">
                  <div class="cal-toggle-card__info">
                    <span class="cal-toggle-card__name">${e.friendly_name}</span>
                    <span class="cal-toggle-card__entity">${e.entity_id}</span>
                    <span class="cal-toggle-card__state">${stateLabel}</span>
                  </div>
                  <label class="toggle-label">
                    <input type="checkbox" class="todo-entity-toggle" value="${e.entity_id}" ${isEnabled ? "checked" : ""} />
                    <span class="toggle-slider"></span>
                  </label>
                </div>`;
              })
              .join("");

            // Wire toggle card click + checkbox change
            entitiesContainer
              .querySelectorAll<HTMLInputElement>(".todo-entity-toggle")
              .forEach((cb) => {
                cb.addEventListener("change", () => {
                  const card = cb.closest(".cal-toggle-card");
                  if (card) {
                    card.classList.toggle(
                      "cal-toggle-card--active",
                      cb.checked,
                    );
                  }
                  updateTodoCount();
                });
              });

            entitiesContainer
              .querySelectorAll<HTMLElement>(".cal-toggle-card")
              .forEach((card) => {
                card.addEventListener("click", (e) => {
                  if ((e.target as HTMLElement).closest(".toggle-label"))
                    return;
                  const cb = card.querySelector<HTMLInputElement>(
                    ".todo-entity-toggle",
                  );
                  if (cb) {
                    cb.checked = !cb.checked;
                    cb.dispatchEvent(new Event("change", { bubbles: true }));
                  }
                });
              });

            // Auto-enable sync toggle if entities found and auto-selected
            if (autoSelect && enabledCb && !enabledCb.checked) {
              enabledCb.checked = true;
              if (enabledLabel)
                enabledLabel.textContent = "On — syncing with HA";
            }
          }
          updateTodoCount();
        }

        // Update badge based on sync status
        const anyActive = entities.some((e) => e.sync?.active);
        if (statusEl) {
          if (anyActive) {
            statusEl.textContent = "Active";
            statusEl.className = "badge badge-active";
          } else if (entities.length > 0) {
            statusEl.textContent = `${entities.length} found`;
            statusEl.className = "badge badge-active";
          } else {
            statusEl.textContent = "No lists";
            statusEl.className = "badge badge-pending";
          }
        }
      } catch {
        if (statusEl) {
          statusEl.textContent = "Unavailable";
          statusEl.className = "badge badge-pending";
        }
      }
    }
    hydrateTodoStatus();

    // Bulk enable/disable all todo entities
    document
      .getElementById("todo-enable-all")
      ?.addEventListener("click", () => {
        document
          .querySelectorAll<HTMLInputElement>(
            "#todo-entities-container .todo-entity-toggle",
          )
          .forEach((cb) => {
            if (!cb.checked) {
              cb.checked = true;
              cb.closest(".cal-toggle-card")?.classList.add(
                "cal-toggle-card--active",
              );
            }
          });
        updateTodoCount();
      });

    document
      .getElementById("todo-disable-all")
      ?.addEventListener("click", () => {
        document
          .querySelectorAll<HTMLInputElement>(
            "#todo-entities-container .todo-entity-toggle",
          )
          .forEach((cb) => {
            if (cb.checked) {
              cb.checked = false;
              cb.closest(".cal-toggle-card")?.classList.remove(
                "cal-toggle-card--active",
              );
            }
          });
        updateTodoCount();
      });

    // Manual entity add button
    document
      .getElementById("todo-add-manual")
      ?.addEventListener("click", () => {
        const input = document.getElementById(
          "todo-entity-manual",
        ) as HTMLInputElement;
        const entityId = input?.value?.trim();
        if (!entityId || !entityId.startsWith("todo.")) {
          showToast(
            "Enter a valid entity ID (e.g. todo.shopping_list)",
            "error",
          );
          return;
        }
        const container = document.getElementById("todo-entities-container");
        if (!container) return;
        // Check if already exists
        if (container.querySelector(`[data-entity="${entityId}"]`)) {
          showToast("Entity already in the list", "error");
          return;
        }
        const card = document.createElement("div");
        card.className = "cal-toggle-card cal-toggle-card--active";
        card.dataset.entity = entityId;
        card.innerHTML = `
          <div class="cal-toggle-card__info">
            <span class="cal-toggle-card__name"></span>
            <span class="cal-toggle-card__entity"></span>
            <span class="cal-toggle-card__state">manually added</span>
          </div>
          <label class="toggle-label">
            <input type="checkbox" class="todo-entity-toggle" checked />
            <span class="toggle-slider"></span>
          </label>`;
        const todoName = card.querySelector<HTMLElement>(".cal-toggle-card__name");
        if (todoName) todoName.textContent = entityId;
        const todoEntity = card.querySelector<HTMLElement>(".cal-toggle-card__entity");
        if (todoEntity) todoEntity.textContent = entityId;
        const todoToggle = card.querySelector<HTMLInputElement>(".todo-entity-toggle");
        if (todoToggle) todoToggle.value = entityId;
        card
          .querySelector<HTMLInputElement>(".todo-entity-toggle")
          ?.addEventListener("change", function () {
            card.classList.toggle("cal-toggle-card--active", this.checked);
            updateTodoCount();
          });
        card.addEventListener("click", (e) => {
          if ((e.target as HTMLElement).closest(".toggle-label")) return;
          const cb = card.querySelector<HTMLInputElement>(
            ".todo-entity-toggle",
          );
          if (cb) {
            cb.checked = !cb.checked;
            cb.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        container.appendChild(card);
        const noEntities = document.getElementById("todo-no-entities");
        if (noEntities) noEntities.style.display = "none";
        updateTodoCount();
        input.value = "";
      });

    // Enable/disable toggle label update
    document
      .getElementById("todo-enabled")
      ?.addEventListener("change", function () {
        const cb = this as HTMLInputElement;
        const label = document.getElementById("todo-enabled-label");
        if (label) {
          label.textContent = cb.checked
            ? "On — syncing with HA"
            : "Off — sync disabled to save power";
        }
      });

    // Save todo settings
    document
      .getElementById("save-todo")
      ?.addEventListener("click", async () => {
        const enabled = (
          document.getElementById("todo-enabled") as HTMLInputElement
        ).checked;
        // Collect enabled entities from toggle cards
        const enabledEntities = Array.from(
          document.querySelectorAll<HTMLInputElement>(
            "#todo-entities-container .todo-entity-toggle:checked",
          ),
        ).map((cb) => cb.value);
        const direction = (
          document.getElementById("todo-sync-direction") as HTMLSelectElement
        ).value;

        if (enabled && enabledEntities.length === 0) {
          showToast("Enable at least one todo list, or disable sync", "error");
          return;
        }

        const btn = document.getElementById("save-todo") as HTMLButtonElement;
        btn.textContent = "Saving...";
        btn.disabled = true;

        await saveSetting("todo_sync_enabled", enabled);
        await saveSetting("todo_entities", enabledEntities);
        await saveSetting("todo_entity", enabledEntities[0] || "");
        await saveSetting("todo_sync_direction", direction);

        // Enable/disable sync via API
        if (enabled && enabledEntities.length > 0) {
          try {
            await fetch((window.__ingress_path || "") + "/api/todo/sync", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "enable",
                entity_id: enabledEntities[0],
                entities: enabledEntities,
                direction,
              }),
            });
          } catch {
            /* logged server-side */
          }
        } else {
          try {
            await fetch((window.__ingress_path || "") + "/api/todo/sync", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ action: "disable" }),
            });
          } catch {
            /* logged server-side */
          }
        }

        // Update status badge
        const statusEl = document.getElementById("todo-status");
        if (statusEl) {
          statusEl.textContent = enabled
            ? `${enabledEntities.length} syncing`
            : "Disabled";
          statusEl.className = enabled
            ? "badge badge-active"
            : "badge badge-pending";
        }

        btn.textContent = "Save Todo Settings";
        btn.disabled = false;
        showToast("settings.todo_saved");
      });

    // Sync Now button
    document
      .getElementById("sync-todo")
      ?.addEventListener("click", async () => {
        const btn = document.getElementById("sync-todo") as HTMLButtonElement;
        const resultEl = document.getElementById("todo-sync-result");
        btn.textContent = "Syncing...";
        btn.disabled = true;

        try {
          const enabledTodos = Array.from(
            document.querySelectorAll<HTMLInputElement>(
              "#todo-entities-container .todo-entity-toggle:checked",
            ),
          ).map((cb) => cb.value);
          const entity = enabledTodos[0] || undefined;
          const res = await fetch(
            (window.__ingress_path || "") + "/api/todo/sync",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "sync",
                entity_id: entity || undefined,
              }),
            },
          );
          const data = (await res.json()) as {
            ok: boolean;
            synced?: number;
            errors?: number;
            message?: string;
            ha_connected?: boolean;
            status?: unknown;
          };
          const msg =
            data.message ?? (data.ok ? "Sync triggered" : "Sync failed");
          if (resultEl) resultEl.textContent = msg;

          // Show appropriate toast based on HA connection state
          const isOk = data.ok && data.ha_connected !== false;
          showToast(
            isOk ? `✅ ${msg}` : `⚠️ ${msg}`,
            isOk ? "success" : "error",
          );
          // Update last-synced timestamp
          if (data.ok) {
            const lastSynced = document.getElementById("todo-last-synced");
            if (lastSynced)
              lastSynced.textContent = `Last synced: ${new Date().toLocaleTimeString()}${data.synced ? ` — ${data.synced} item(s)` : ""}`;
          }
        } catch {
          if (resultEl) resultEl.textContent = "Sync failed";
          showToast("❌ Todo sync failed", "error");
        }

        btn.textContent = "Sync Now";
        btn.disabled = false;
        setTimeout(() => {
          if (resultEl) resultEl.textContent = "";
        }, 5000);
      });

    // ───── Restore Integration Settings ─────
    (async function restoreIntegrationSettings() {
      try {
        const res = await fetch(
          (window.__ingress_path || "") + "/api/settings",
        );
        if (!res.ok) return;
        const s = (await res.json()) as Record<string, unknown>;

        // Grocy
        if (s.grocy_url)
          (document.getElementById("grocy-url") as HTMLInputElement).value =
            String(s.grocy_url);
        if (s.grocy_sync_mode)
          (
            document.getElementById("grocy-sync-mode") as HTMLSelectElement
          ).value = String(s.grocy_sync_mode);
        if (s.grocy_url) {
          const el = document.getElementById("grocy-status");
          if (el) {
            el.textContent = "Configured";
            el.className = "badge badge-active";
          }
          // Auto-expand configured card
          window.expandIntegrationCard?.("integration-grocy-body");
        }

        // Calendar — pre-check saved entities in toggle cards
        const calEntityVal =
          s.calendar_entities ?? s.calendar_entity ?? s.cal_entity;
        if (calEntityVal) {
          // Toggle cards are pre-checked during hydrateCalendarStatus fetch
          // Auto-expand configured card
          window.expandIntegrationCard?.("integration-calendar-body");
        }
        if (s.caldav_url) {
          (document.getElementById("caldav-url") as HTMLInputElement).value =
            String(s.caldav_url);
          try {
            const credRes = await fetch(
              (window.__ingress_path || "") +
                "/api/integrations/calendar/caldav-credentials",
            );
            if (credRes.ok) {
              const credData = await credRes.json();
              if (credData.configured) {
                const indicator = document.getElementById(
                  "caldav-active-indicator",
                );
                if (indicator) indicator.style.display = "block";
                if (credData.username) {
                  (
                    document.getElementById(
                      "caldav-username",
                    ) as HTMLInputElement
                  ).value = credData.username;
                }
              }
            }
          } catch {
            /* CalDAV credentials are optional — don't block settings restore */
          }
        }
        if (s.calendar_write_back) {
          const wb = document.getElementById(
            "cal-write-back",
          ) as HTMLInputElement | null;
          if (wb)
            wb.checked =
              s.calendar_write_back === true ||
              s.calendar_write_back === "true";
        }
        // Restore sync interval
        if (s.calendar_sync_interval_ms) {
          const intervalSel = document.getElementById(
            "cal-sync-interval",
          ) as HTMLSelectElement | null;
          if (intervalSel)
            intervalSel.value = String(s.calendar_sync_interval_ms);
        }

        // Todo Sync
        // Todo — set value on both select and manual input of EntitySelector
        if (s.todo_entity) {
          const todoSelect = document.getElementById(
            "todo-entity",
          ) as HTMLSelectElement | null;
          const todoManual = document.getElementById(
            "todo-entity-manual",
          ) as HTMLInputElement | null;
          if (todoSelect) todoSelect.value = String(s.todo_entity);
          if (todoManual) todoManual.value = String(s.todo_entity);
        }
        if (s.todo_sync_direction)
          (
            document.getElementById("todo-sync-direction") as HTMLSelectElement
          ).value = String(s.todo_sync_direction);
        if (s.todo_sync_enabled) {
          (
            document.getElementById("todo-enabled") as HTMLInputElement
          ).checked = true;
          const label = document.getElementById("todo-enabled-label");
          if (label) label.textContent = "On — syncing with HA";
          const el = document.getElementById("todo-status");
          if (el) {
            el.textContent = "Active";
            el.className = "badge badge-active";
          }
          // Auto-expand configured card
          window.expandIntegrationCard?.("integration-todo-body");
        }

        // n8n
        if (s.n8n_webhook_url) {
          (
            document.getElementById("n8n-webhook-url") as HTMLInputElement
          ).value = String(s.n8n_webhook_url);
          const el = document.getElementById("n8n-status");
          if (el) {
            el.textContent = "Configured";
            el.className = "badge badge-active";
          }
          // Auto-expand configured card
          window.expandIntegrationCard?.("integration-n8n-body");
        }
        if (Array.isArray(s.n8n_events)) {
          document.querySelectorAll(".n8n-event").forEach((cb) => {
            (cb as HTMLInputElement).checked = (
              s.n8n_events as string[]
            ).includes((cb as HTMLInputElement).value);
          });
          // Also restore standalone event checkboxes
          document.querySelectorAll(".n8n-event-standalone").forEach((cb) => {
            (cb as HTMLInputElement).checked = (
              s.n8n_events as string[]
            ).includes((cb as HTMLInputElement).value);
          });
        }
        // n8n standalone fields
        if (s.n8n_api_key) {
          (document.getElementById("n8n-api-key") as HTMLInputElement).value =
            String(s.n8n_api_key);
        }
        if (s.n8n_signing_secret) {
          (document.getElementById("n8n-secret") as HTMLInputElement).value =
            String(s.n8n_signing_secret);
        }
        // Switch to standalone tab if mode is standalone
        if (s.n8n_mode === "standalone") {
          const autoTab = document.getElementById("n8n-mode-auto");
          const standaloneTab = document.getElementById("n8n-mode-standalone");
          const autoContent = document.getElementById("n8n-auto-content");
          const standaloneContent = document.getElementById(
            "n8n-standalone-content",
          );
          if (autoTab && standaloneTab) {
            autoTab.classList.remove("mode-tab--active");
            standaloneTab.classList.add("mode-tab--active");
          }
          if (autoContent) autoContent.style.display = "none";
          if (standaloneContent) standaloneContent.style.display = "";
        }

        // Webhook
        if (s.webhook_endpoint)
          (
            document.getElementById("webhook-endpoint") as HTMLInputElement
          ).value = String(s.webhook_endpoint);
        if (s.webhook_format)
          (
            document.getElementById("webhook-format") as HTMLSelectElement
          ).value = String(s.webhook_format);
        if (s.webhook_endpoint) {
          const el = document.getElementById("webhook-status");
          if (el) {
            el.textContent = "Active";
            el.className = "badge badge-active";
          }
          // Auto-expand configured card
          window.expandIntegrationCard?.("integration-webhooks-body");
        } else {
          const el = document.getElementById("webhook-status");
          if (el) {
            el.textContent = "Not configured";
            el.className = "badge badge-pending";
          }
        }

        // Agent Protocols
        const a2aEnabled = s["agent-protocols-a2a-enabled"];
        const webmcpEnabled = s["agent-protocols-webmcp-enabled"];
        const mcpEnabled = s["agent-protocols-mcp-enabled"];
        if (a2aEnabled !== undefined)
          (
            document.getElementById("agent-a2a-enabled") as HTMLInputElement
          ).checked = a2aEnabled === true || a2aEnabled === "true";
        if (webmcpEnabled !== undefined)
          (
            document.getElementById("agent-webmcp-enabled") as HTMLInputElement
          ).checked = webmcpEnabled === true || webmcpEnabled === "true";
        if (mcpEnabled !== undefined)
          (
            document.getElementById("agent-mcp-enabled") as HTMLInputElement
          ).checked = mcpEnabled === true || mcpEnabled === "true";
        {
          const anyConfigured =
            a2aEnabled !== undefined ||
            webmcpEnabled !== undefined ||
            mcpEnabled !== undefined;
          const anyActive =
            a2aEnabled === true ||
            a2aEnabled === "true" ||
            webmcpEnabled === true ||
            webmcpEnabled === "true" ||
            mcpEnabled === true ||
            mcpEnabled === "true";
          const statusEl = document.getElementById("agent-protocols-status");
          if (statusEl && anyConfigured) {
            statusEl.textContent = anyActive ? "Active" : "Disabled";
            statusEl.className = anyActive
              ? "badge badge-active"
              : "badge badge-pending";
          }
        }
      } catch {
        /* settings not available */
      }
    })();

    // ───── Danger Zone ─────
    document
      .getElementById("purge-tasks")
      ?.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Purge All Tasks",
          message:
            "This will permanently delete ALL tasks. This action is irreversible.",
          variant: "danger",
          confirmText: "Purge Everything",
        });
        if (!ok) return;
        const typed = prompt("Type YES to confirm purge:");
        if (typed?.toUpperCase() !== "YES") {
          showToast("settings.purge_cancelled", "error");
          return;
        }
        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/tasks?purge=all",
            { method: "DELETE" },
          );
          if (res.ok) {
            showToast("settings.purge_success");
            setTimeout(() => window.location.reload(), 1000);
          } else showToast("settings.purge_failed", "error");
        } catch {
          showToast("common.network_error", "error");
        }
      });

    document
      .getElementById("reset-settings")
      ?.addEventListener("click", async () => {
        const ok = await confirmDialog({
          title: "Reset Settings",
          message: "This will reset ALL settings to their default values.",
          variant: "warning",
          confirmText: "Reset All",
        });
        if (!ok) return;
        try {
          const res = await fetch(
            (window.__ingress_path || "") + "/api/settings?reset=all",
            {
              method: "DELETE",
            },
          );
          if (res.ok) {
            showToast("settings.reset_success");
            settingsStore.invalidate()
            setTimeout(() => window.location.reload(), 1000);
          } else showToast("settings.reset_failed", "error");
        } catch {
          showToast("common.network_error", "error");
        }
      });

    // Language selector — persist to API, cookie, localStorage
    document
      .getElementById("locale-select")
      ?.addEventListener("change", async (e) => {
        const locale = (e.target as HTMLSelectElement).value;
        // Store in localStorage
        localStorage.setItem("meitheal-locale", locale);
        // Set cookie for SSR
        document.cookie = `meitheal-locale=${locale};path=/;max-age=31536000;SameSite=Lax`;
        // Persist to settings API
        try {
          await fetch((window.__ingress_path || "") + "/api/settings", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: "locale", value: locale }),
          });
        } catch {
          /* ignore API errors */
        }
        // Dispatch event for any listening components
        window.dispatchEvent(
          new CustomEvent("meitheal:locale-changed", { detail: { locale } }),
        );
        // Reload to get SSR-rendered translations
        showToast(
          locale === "ga"
            ? "Teanga athraithe go Gaeilge"
            : "Language changed to English",
        );
        setTimeout(() => window.location.reload(), 800);
      });

    // Theme selector — instant apply + persist via theme-watcher
    document
      .getElementById("theme-select")
      ?.addEventListener("change", async (e) => {
        const theme = (e.target as HTMLSelectElement).value as ThemeMode;
        // Use theme-watcher for proper class + data-theme + meta handling
        importedSetTheme(theme);
        await saveSetting("theme", theme);
        showCustomThemeSection(theme === "custom");
        showToast(
          theme === "dark"
            ? "Theme: Dark"
            : theme === "light"
              ? "Theme: Light"
              : theme === "auto"
                ? "Theme: Auto (System)"
                : "Theme: Custom",
        );
      });

    // Custom theme file import handler
    document
      .getElementById("custom-theme-input")
      ?.addEventListener("change", async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;

        // Validate file extension
        if (!file.name.endsWith(".css")) {
          showToast("Only .css files are allowed", "error");
          (e.target as HTMLInputElement).value = "";
          return;
        }

        // Validate MIME type
        if (
          file.type &&
          file.type !== "text/css" &&
          !file.type.startsWith("text/")
        ) {
          showToast("Invalid file type — must be a CSS file", "error");
          (e.target as HTMLInputElement).value = "";
          return;
        }

        // Validate size
        if (file.size > MAX_THEME_SIZE) {
          showToast(
            `File too large (${Math.round(file.size / 1024)}KB) — max 50KB`,
            "error",
          );
          (e.target as HTMLInputElement).value = "";
          return;
        }

        try {
          const rawCSS = await file.text();
          const cleanCSS = sanitizeCSS(rawCSS);

          // Store in localStorage for instant apply
          localStorage.setItem("meitheal-custom-theme-css", cleanCSS);

          // Apply immediately
          importedSetTheme("custom");
          importedApplyCustomTheme(cleanCSS);

          // Persist to server
          await saveSetting("custom_theme_css", cleanCSS);
          await saveSetting("custom_theme_name", file.name);
          await saveSetting("theme", "custom");

          // Update UI
          updateCustomThemeDisplay(file.name);
          const themeEl = document.getElementById(
            "theme-select",
          ) as HTMLSelectElement;
          if (themeEl) themeEl.value = "custom";
          showToast(`Theme imported: ${file.name}`);
        } catch (err) {
          console.error("Failed to import custom theme:", err);
          showToast("Failed to import theme", "error");
        }

        // Reset input so re-importing same file works
        (e.target as HTMLInputElement).value = "";
      });

    // Custom theme delete handler
    document
      .getElementById("custom-theme-delete")
      ?.addEventListener("click", async () => {
        const ok = await confirmDialog({
          message: "Remove custom theme? The app will revert to Dark mode.",
          variant: "warning",
        });
        if (!ok) return;

        // Clear from localStorage
        localStorage.removeItem("meitheal-custom-theme-css");

        // Remove injected style
        importedApplyCustomTheme(null);

        // Revert to dark
        importedSetTheme("dark");
        const themeEl = document.getElementById(
          "theme-select",
        ) as HTMLSelectElement;
        if (themeEl) themeEl.value = "dark";

        // Clear from server
        await saveSetting("theme", "dark");
        await saveSetting("custom_theme_css", "");
        await saveSetting("custom_theme_name", "");

        // Update UI
        updateCustomThemeDisplay(null);
        showToast("Custom theme removed — reverted to Dark");
      });

    // Custom theme filename click — download the stored CSS
    document
      .getElementById("custom-theme-filename")
      ?.addEventListener("click", (e) => {
        e.preventDefault();
        const css = localStorage.getItem("meitheal-custom-theme-css");
        if (!css) return;
        const blob = new Blob([css], { type: "text/css" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download =
          document.getElementById("custom-theme-filename")?.textContent ||
          "custom-theme.css";
        a.click();
        URL.revokeObjectURL(url);
      });

    // Timezone selector — persist to API + localStorage
    document
      .getElementById("timezone-select")
      ?.addEventListener("change", async (e) => {
        const tz = (e.target as HTMLSelectElement).value;
        localStorage.setItem("meitheal-timezone", tz);
        await saveSetting("timezone", tz);
        showToast("common.updated");
      });

    // Week start selector
    document
      .getElementById("week-start-select")
      ?.addEventListener("change", async (e) => {
        const ws = (e.target as HTMLSelectElement).value;
        localStorage.setItem("meitheal-week-start", ws);
        await saveSetting("week_start", ws);
        showToast("common.updated");
      });

    // Date format selector
    document
      .getElementById("date-format-select")
      ?.addEventListener("change", async (e) => {
        const df = (e.target as HTMLSelectElement).value;
        localStorage.setItem("meitheal-date-format", df);
        await saveSetting("date_format", df);
        showToast("common.updated");
      });

    // Init
    loadSettings();

}
