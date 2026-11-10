export function shouldSkipBrowserSpecs(): boolean {
  return !process.env.E2E_BASE_URL;
}
