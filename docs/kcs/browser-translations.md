# Browser translations

The server resolves the locale cookie and renders translated text. `i18n/translations.ts` owns the complete English and Irish catalogs and resolves missing Irish strings through English, including legacy locale-wrapped settings keys.

Browser controllers import `i18n/client.ts`. Layout sends one selected catalog with English fallback already resolved on the server. A small alternate-locale scope covers programmatic pin, workflow status, deferral, inactivity and triage messages. This lets a pin message honor a stored locale that differs from the rendered cookie without shipping both complete catalogs in JavaScript. Add any new explicitly localized programmatic message to that server scope. Other one-argument `window.mI18n.get(key)` calls keep the selected SSR locale.

`I18nText` renders escaped English and Irish variants on each element. It responds to locale and storage events, including Irish-rendered pages switching to English. Missing translations preserve the component fallback. It removes its listeners when disconnected.

For a translation regression, run `pnpm --filter @meitheal/tests test e2e/client-translations.spec.ts`. Browser checks require a disposable App server, such as the existing `MEITHEAL_TEST_BROWSER=1` fixture after building. During Tier 1 development, point `E2E_BASE_URL` at `npm run dev` and set `MEITHEAL_CATALOG_DEV=1`. Check both cookie/storage mismatch and another tab changing the stored locale. Settings YAML import must still show server validation errors and submit the original document to the shared creation endpoint. See [Framework YAML import](framework-yaml-import.md).

Build before checking generated asset sizes. Keep fonts, rendering assets, the service worker and the existing performance budget unchanged; removing duplicate catalog delivery does not establish Home Assistant hardware memory acceptance.
