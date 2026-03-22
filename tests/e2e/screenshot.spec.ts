import { test, expect } from '@playwright/test';
test('take screenshot', async ({ page }) => {
  await page.goto('http://localhost:4321/tasks');
  await page.waitForTimeout(2000);
  await page.click('#kanban-advanced-toggle');
  await page.waitForTimeout(500);
  // add a condition
  await page.click('#kanban-advanced-add-condition');
  await page.waitForTimeout(200);
  await page.screenshot({ path: '/home/ryan/.gemini/antigravity/brain/3bf7a77c-860e-48a5-a07d-fa9f7a08f72b/advanced_filter_fixed_2.png', fullPage: true });
});
