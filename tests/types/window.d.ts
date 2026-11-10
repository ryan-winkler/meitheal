/**
 * Window type extensions for test environment.
 *
 * Re-exports the Meitheal Window extensions so tests that
 * import app lib files using `window.__ingress_path` etc.
 * see the correct types without needing the full Astro env.
 *
 * @domain shared
 */
/// <reference path="../../apps/web/src/types/window.d.ts" />
