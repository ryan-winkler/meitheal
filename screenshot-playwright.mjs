import { chromium } from 'playwright-core';
import os from 'os';

(async () => {
  // Use existing Chrome for Playwright if available or fallback
  let executablePath = '/usr/bin/google-chrome';
  try {
    const browser = await chromium.launch({ 
      channel: 'chrome', // Use system chrome
      headless: true
    });
    const page = await browser.newPage({ 
      viewport: { width: 1440, height: 900 } 
    });
    await page.goto('http://localhost:4321/tasks');
    await page.waitForTimeout(2000);
    
    // Click Filters to open the panel
    await page.click('button:has-text("Filters")');
    await page.waitForTimeout(500);
    
    // Take screenshot of the advanced filter
    const path = '/home/ryan/.gemini/antigravity/brain/3bf7a77c-860e-48a5-a07d-fa9f7a08f72b/advanced_filter.png';
    await page.screenshot({ path });
    console.log('Saved to', path);
    
    await browser.close();
  } catch(e) {
    console.error(e);
  }
})();
