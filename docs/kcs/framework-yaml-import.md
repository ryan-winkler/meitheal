---
type: Runbook
title: Import a framework from YAML
description: Import a framework and diagnose validation or size errors.
---
# Import a framework from YAML

Open Settings → Rules & Lenses → Import YAML. Paste one YAML document with a `name`, the required fields, and a formula when the archetype is `formula`. Settings sends the document to the existing `POST /api/frameworks` endpoint as `application/yaml`. The server parses it, generates the ID from the name, maps the existing snake_case YAML fields, and applies the same validation and ID collision checks as JSON framework creation. A successful response is `201`; imported frameworks retain `source: imported`.

The complete YAML parser stays on the server. Both the Settings form and the server limit imports to 64 KiB of UTF-8. The server checks the actual streamed byte count before parsing, rejects invalid UTF-8, bounds document nesting to 64 AST levels before conversion, and keeps the YAML library's limit of 100 alias expansions. Normal flow mappings, block scalars, Unicode and bounded aliases remain supported. Multiple documents and cyclic values that cannot be stored as JSON are rejected.

If the dialog stays open, read its error before retrying:

- `400`: correct the YAML syntax, required name, fields or formula. Deep or excessively aliased documents must be simplified.
- `409`: change the name if its generated ID is already used, including by a built-in framework.
- `413`: reduce the document below 64 KiB. This is a byte limit, so accented letters and emoji can use several bytes each.
- An unavailable API or storage error: retain the pasted text and retry after connectivity or service recovery. No success is shown for a failed request.

Existing `application/json` clients keep their camelCase configuration payload and validation behavior. Both representations use the existing authorization and ingress-safe fetch path. See the generated OpenAPI `createFramework` operation for request formats and responses.

Run `pnpm --filter @meitheal/tests test e2e/framework-yaml-import.spec.ts e2e/client-translations.spec.ts`. Browser/API checks require the existing disposable fixture (`MEITHEAL_TEST_BROWSER=1`) after building. Check an actual Settings import behind ingress, invalid and oversized input, a duplicate ID, and a server failure. Build and run the unchanged `perf:budget` check to verify aggregate client bytes; code splitting alone does not reduce that total.


Built-in framework list, detail, override/reset and YAML export use the existing Astro `frameworks` content collection. Astro includes those definitions in the packaged SSR output; APIs must not resolve YAML relative to a compiled chunk or require the source checkout. A missing production catalog can hide built-in ID conflicts even while the ticket editor's SSR fallback still shows RICE. Verify the packaged registry includes the baked definitions and rejects imports that shadow a built-in. Export returns the built-in defaults, including while user overrides are active.

Formulas use declared field keys, numbers, parentheses and the four arithmetic operators. A checked box contributes 1 and an unchecked box contributes 0. New definitions, YAML imports and formula edits reject unsupported expressions. Numeric bounds must be finite and ordered. Field descriptions and select options survive YAML export and import.

A legacy framework with unsupported scoring settings remains in the catalog and in Rules backups. The ticket editor keeps its stored estimates and explains why scoring is unavailable. To repair it, export the configuration from Settings → Rules & Lenses, correct the formula, bounds, or options in the framework entry, then re-import the file. An administrator can also update a custom definition through `PUT /api/frameworks/{id}` or reset a built-in to its packaged defaults. Rules import checks the backup's structure before writing and applies rules, overrides and custom definitions in one transaction.
