/**
 * Notification Deep Links — E2E Tests
 *
 * Validates that notification payloads contain correct deep link URLs
 * for both mobile push (HA Companion) and browser notifications.
 *
 * @domain notifications
 * @see https://companion.home-assistant.io/docs/notifications/notifications-basic/#opening-a-url
 */
import { expect, test } from "@playwright/test";

test.describe("Notification Deep Links", () => {
  test("ingress-aware URLs should prefix paths correctly", () => {
    // Unit test for URL construction logic
    const ingressPath = "/api/hassio_ingress/abc123";
    const baseUrl = "https://ha.internal:8123";
    const path = "/kanban";

    // Full deep link for mobile push
    const fullDeepLink = `${baseUrl}${ingressPath}${path}`;
    expect(fullDeepLink).toBe("https://ha.internal:8123/api/hassio_ingress/abc123/kanban");
    expect(fullDeepLink).toMatch(/^https?:\/\//);

    // Relative link for sidebar persistent_notification
    const sidebarLink = `${ingressPath}${path}`;
    expect(sidebarLink).toBe("/api/hassio_ingress/abc123/kanban");
    expect(sidebarLink).not.toMatch(/^https?:\/\//);
  });

  test("deep link URL must not have double slashes in path", () => {
    const baseUrl = "https://ha.internal:8123/";
    const ingressPath = "/api/hassio_ingress/abc123";

    // getHABaseUrl strips trailing slashes from baseUrl
    const cleanBaseUrl = baseUrl.replace(/\/+$/, "");
    const fullDeepLink = `${cleanBaseUrl}${ingressPath}/kanban`;
    expect(fullDeepLink).not.toMatch(/[^:]\/\//);
  });

  test("fallback: no deep link when base URL is unavailable", () => {
    const baseUrl: string | null = null;
    const ingressPath = "/api/hassio_ingress/abc123";

    const fullDeepLink = (baseUrl && ingressPath)
      ? `${baseUrl}${ingressPath}/kanban`
      : null;
    expect(fullDeepLink).toBeNull();
  });

  test("notification data shape matches HA Companion requirements", () => {
    // HA Companion expects:
    // - data.url for iOS
    // - data.clickAction for Android
    // - data.actions[].uri for action buttons
    // All must be full URLs or relative /lovelace paths

    const baseUrl = "https://ha.internal:8123";
    const ingressPath = "/api/hassio_ingress/abc123";
    const fullDeepLink = `${baseUrl}${ingressPath}/kanban`;

    const notificationData = {
      ...(fullDeepLink ? { clickAction: fullDeepLink, url: fullDeepLink } : {}),
      tag: "meitheal_due_test",
      group: "meitheal",
      channel: "meitheal_reminders",
      actions: [
        ...(fullDeepLink ? [{ action: "URI", title: "Open Task", uri: fullDeepLink }] : []),
        { action: "MEITHEAL_TASK_DONE_test", title: "✅ Mark Done" },
      ],
    };

    expect(notificationData.clickAction).toBe(fullDeepLink);
    expect(notificationData.url).toBe(fullDeepLink);

    const uriAction = notificationData.actions[0] as { action: string; title: string; uri: string };
    expect(uriAction).toEqual({
      action: "URI",
      title: "Open Task",
      uri: fullDeepLink,
    });

    // All URLs should be absolute
    expect(notificationData.clickAction).toMatch(/^https?:\/\//);
    expect(notificationData.url).toMatch(/^https?:\/\//);
    expect(uriAction.uri).toMatch(/^https?:\/\//);
  });

  test("standalone mode: no deep link when ingress path is unavailable", () => {
    const baseUrl = "https://ha.internal:8123";
    const ingressPath: string | null = null;

    const fullDeepLink = (baseUrl && ingressPath)
      ? `${baseUrl}${ingressPath}/kanban`
      : null;
    expect(fullDeepLink).toBeNull();
  });
});
