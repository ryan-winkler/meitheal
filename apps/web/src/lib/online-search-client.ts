import type { SearchResponse } from "@domains/search"
import { workerAllowsNetworkOnly } from "@lib/network-only-worker"

export function searchWorkerScope(): URL {
  return new URL((window.__ingress_path?.replace(/\/+$/, "") ?? "") + "/", window.location.origin)
}

export async function searchRegistration(scope: URL) {
  const registration = await navigator.serviceWorker?.getRegistration(scope.href)
  return registration?.scope === scope.href ? registration : undefined
}

export async function searchWorkerReady(scope: URL, worker: ServiceWorker): Promise<boolean> {
  const registration = await searchRegistration(scope)
  return registration?.active === worker && worker.scriptURL === new URL("sw.js", scope).href &&
    await workerAllowsNetworkOnly(worker, "MEITHEAL_SEARCH_NETWORK_ONLY")
}

export async function fetchOnlineSearch(params: URLSearchParams, scope: URL, signal: AbortSignal): Promise<SearchResponse> {
  const endpoint = `api/search?${params}`
  const response = await fetch("/" + endpoint, { cache: "no-store", redirect: "error", signal })
  if (!response.ok || response.url !== new URL(endpoint, scope).href ||
      !response.headers.get("cache-control")?.includes("no-store")) {
    void response.body?.cancel()
    throw new Error(`Search failed: ${response.status}`)
  }
  return response.json() as Promise<SearchResponse>
}
