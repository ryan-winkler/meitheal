import type { Page } from "@playwright/test"

export function shouldSkipBrowserSpecs(): boolean {
  return !process.env.E2E_BASE_URL;
}

export function readScopedNavigation(page: Page) {
  return page.evaluate(() => {
    const scope = document.documentElement.dataset.workspaceScope
    if (!scope) throw new Error("Expected an account-scoped workspace")
    return JSON.parse(sessionStorage.getItem("meitheal-navigation-state:" + scope) ?? "null")
  })
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
