import { getCollection, type CollectionEntry } from "astro:content"
import { parseFrameworkConfig, type FrameworkConfig } from "@meitheal/domain-strategy"

/** Astro bakes these definitions into SSR output; no runtime source tree is required. */
export async function listBuiltInFrameworks(): Promise<FrameworkConfig[]> {
  return (await getCollection("frameworks")).map((entry: CollectionEntry<"frameworks">) => ({
    ...parseFrameworkConfig(entry.id, entry.data), source: "built-in",
  }))
}

export async function getBuiltInFramework(id: string): Promise<FrameworkConfig | null> {
  return (await listBuiltInFrameworks()).find(framework => framework.id === id) ?? null
}
