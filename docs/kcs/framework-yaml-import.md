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
