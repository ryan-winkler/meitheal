import AxeBuilder from "@axe-core/playwright"
import type { Page } from "@playwright/test"

type RunOptions = Parameters<AxeBuilder["options"]>[0]

/**
 * Color-contrast audit that measures the real background behind text. Large
 * decorative pseudo-elements, such as the Board's horizontal scroll fade, would
 * otherwise leave axe unable to determine it. axe reads per-check options at run
 * time, but its RunOptions type omits them.
 */
export function contrastAudit(page: Page): AxeBuilder {
  return new AxeBuilder({ page })
    .options({ checks: { "color-contrast": { options: { ignorePseudo: true } } } } as RunOptions)
    .withRules(["color-contrast"])
}
