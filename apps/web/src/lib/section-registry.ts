/**
 * Shared section-registry type — canonical interface for page sections.
 *
 * @domain layout
 * @bounded-context layout (navigation)
 *
 * Every page with UnifiedBar + page-shell-controller defines sections
 * using this shape. Individual registries re-export a typed array of
 * `SectionDescriptor` with a constrained `id` union.
 *
 * @kcs Settings registry extends this with extra fields (navDetail,
 * statusLabel, summaryTitle, fields). It still satisfies SectionDescriptor.
 */

/** Base section shape used by all page registries */
export interface SectionDescriptor<TId extends string = string> {
  /** DOM anchor id for scroll-spy and hash navigation */
  id: TId
  /** Human-readable section label shown in switcher dropdown */
  label: string
  /** Emoji or icon string shown next to the label */
  icon: string
  /** Short description shown in tooltips or section headers */
  description: string
}

/**
 * Type-safe factory that validates section arrays at compile time.
 *
 * @example
 * ```ts
 * type MyId = "my-overview" | "my-detail"
 * export const MY_SECTIONS = defineSections<MyId>([
 *   { id: "my-overview", label: "Overview", icon: "✦", description: "..." },
 *   { id: "my-detail", label: "Detail", icon: "📋", description: "..." },
 * ])
 * ```
 */
export function defineSections<TId extends string>(
  sections: SectionDescriptor<TId>[],
): SectionDescriptor<TId>[] {
  return sections
}
