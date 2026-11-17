import { test } from "@playwright/test"
import { registerTaskSurfaceLayout } from "../scripts/task-surface-layout-fixture"

test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires the disposable Meitheal browser fixture")

for (const theme of ["light", "dark", "knight-rider", "auto"] as const) registerTaskSurfaceLayout(theme)
