import { expect, test } from "@playwright/test";

/**
 * Unit tests for ingress-state-persistence.ts
 *
 * These test the pure functions from the module (save, get, shouldRestore)
 * using a minimal sessionStorage mock.
 */

// Minimal sessionStorage mock for Node.js
const storageMap = new Map<string, string>();
const mockSessionStorage = {
  getItem: (key: string) => storageMap.get(key) ?? null,
  setItem: (key: string, value: string) => storageMap.set(key, value),
  removeItem: (key: string) => storageMap.delete(key),
  clear: () => storageMap.clear(),
};

// Inject sessionStorage mock globally before importing module
(globalThis as any).sessionStorage = mockSessionStorage;

// Import the module under test
import {
  saveNavigationState,
  getNavigationState,
  initStatePersistence,
  saveNavigationDestination,
  shouldRestore,
} from "../../apps/web/src/lib/ingress-state-persistence";

test("saveNavigationState writes correct JSON to sessionStorage", () => {
  storageMap.clear();
  saveNavigationState("/kanban", 150);
  const raw = storageMap.get("meitheal-navigation-state");
  expect(raw).toBeTruthy();

  const state = JSON.parse(raw!);
  expect(state.path).toBe("/kanban");
  expect(state.scrollY).toBe(150);
  expect(typeof state.timestamp).toBe("number");
  expect(Date.now() - state.timestamp).toBeLessThan(1000);
});

test("getNavigationState returns state when fresh (< 60s)", () => {
  storageMap.clear();
  saveNavigationState("/table", 200);
  const state = getNavigationState();
  expect(state).not.toBeNull();
  expect(state!.path).toBe("/table");
  expect(state!.scrollY).toBe(200);
});

test("getNavigationState returns null when expired (> 60s)", () => {
  storageMap.clear();
  storageMap.set(
    "meitheal-navigation-state",
    JSON.stringify({
      path: "/settings",
      scrollY: 0,
      timestamp: Date.now() - 70_000,
    }),
  );
  const state = getNavigationState();
  expect(state).toBeNull();
  expect(storageMap.has("meitheal-navigation-state")).toBe(false);
});

test("getNavigationState returns null for malformed data", () => {
  storageMap.clear();
  storageMap.set("meitheal-navigation-state", '{"path": 123}');
  expect(getNavigationState()).toBeNull();
});

test("shouldRestore returns true when on root with fresh saved route", () => {
  storageMap.clear();
  saveNavigationState("/kanban", 0);
  expect(shouldRestore("/", "/api/hassio_ingress/test-token")).toBe(true);
});

test("shouldRestore returns false when not on root path", () => {
  storageMap.clear();
  saveNavigationState("/kanban", 0);
  expect(shouldRestore("/kanban", "/api/hassio_ingress/test-token")).toBe(false);
});

test("shouldRestore returns false when no ingress path", () => {
  storageMap.clear();
  saveNavigationState("/kanban", 0);
  expect(shouldRestore("/", undefined)).toBe(false);
});

test("shouldRestore returns false when saved path is root", () => {
  storageMap.clear();
  saveNavigationState("/", 0);
  expect(shouldRestore("/", "/api/hassio_ingress/test-token")).toBe(false);
});

test("shouldRestore returns false when no saved state exists", () => {
  storageMap.clear();
  expect(shouldRestore("/", "/api/hassio_ingress/test-token")).toBe(false);
});


test("the old document cannot overwrite an intended ingress route on unload", () => {
  storageMap.clear()
  const prefix = "/api/hassio_ingress/fixture"
  const location = { pathname: prefix + "/settings", search: "", hash: "" }
  const windowFixture = Object.assign(new EventTarget(), { __ingress_path: prefix, location, scrollY: 18 })
  const documentFixture = Object.assign(new EventTarget(), { visibilityState: "visible" })
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  try {
    Object.defineProperty(globalThis, "window", { value: windowFixture, configurable: true })
    Object.defineProperty(globalThis, "document", { value: documentFixture, configurable: true })
    initStatePersistence()
    saveNavigationDestination("/tasks?view=calendar#upcoming")
    documentFixture.visibilityState = "hidden"
    documentFixture.dispatchEvent(new Event("visibilitychange"))
    windowFixture.dispatchEvent(new Event("beforeunload"))
    expect(getNavigationState()).toMatchObject({ path: "/tasks?view=calendar#upcoming", scrollY: 0 })

    Object.assign(location, { pathname: prefix + "/tasks", search: "?view=calendar", hash: "#upcoming" })
    initStatePersistence()
    expect(getNavigationState()).toMatchObject({ path: "/tasks?view=calendar#upcoming", scrollY: 18 })
    windowFixture.dispatchEvent(new Event("beforeunload"))
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
    else Reflect.deleteProperty(globalThis, "document")
  }
})
