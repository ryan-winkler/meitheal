import { expect, test } from "@playwright/test";
test.describe("Phase 27: HA Security Hardening", () => {

    test.describe("AppArmor Profile", () => {
        test("apparmor.txt exists and has expected deny rules", async () => {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const profilePath = path.resolve(
                path.dirname(new URL(import.meta.url).pathname),
                "../../meitheal-hub/apparmor.txt"
            );
            const content = await fs.readFile(profilePath, "utf-8");

            // Must declare a profile with HA-standard flags
            expect(content).toContain("profile meitheal flags=(attach_disconnected,mediate_deleted)");

            // The file currently blocks /boot/** wl, via other rules (omitted from explicit deny)
            // S6-overlay requires /bin/** ix, so explicit shell deny was removed.

            // Must deny raw sockets
            expect(content).toContain("deny network raw,");
            expect(content).toContain("deny network packet,");

            // Must allow Node.js execution
            expect(content).toContain("/usr/bin/node ix,");

            // Must allow data directory write
            expect(content).toContain("/data/** rwk,");

            // Must deny mount
            expect(content).toContain("deny mount,");

            // Must deny firmware/kernel security access
            expect(content).toContain("deny /sys/firmware/** rwklx,");
            expect(content).toContain("deny /sys/kernel/security/** rwklx,");
        });
    });

    test.describe("config.yaml Security Flags", () => {
        test("both channels use ingress without a Core config mount or auth API access", async () => {
            const fs = await import("node:fs/promises");
            for (const channel of ["meitheal-hub", "meitheal-hub-canary"]) {
                const content = await fs.readFile(new URL(`../../${channel}/config.yaml`, import.meta.url), "utf-8");
                expect(content).not.toContain("auth_api:");
                expect(content).not.toContain("homeassistant_config:");
                expect(content).toContain('loki_url: ""');
                expect(content).toContain("panel_admin: false");
                expect(content).toContain("tmpfs: true");
                expect(content).toContain("ingress: true");
            }
            const startup = await fs.readFile(new URL("../../meitheal-hub/run.sh", import.meta.url), "utf-8");
            expect(startup).not.toContain("/homeassistant/custom_components");
            expect(startup).not.toContain('${INGRESS_PATH}');
        });
    });

    test.describe("Translations", () => {
        test("translations/en.yaml exists and covers config options", async () => {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const transPath = path.resolve(
                path.dirname(new URL(import.meta.url).pathname),
                "../../meitheal-hub/translations/en.yaml"
            );
            const content = await fs.readFile(transPath, "utf-8");

            // Must have all config option keys
            expect(content).toContain("log_level:");
            expect(content).toContain("log_categories:");
            expect(content).toContain("log_redaction:");
            expect(content).toContain("audit_enabled:");
            expect(content).toContain("loki_url:");
        });
    });

    test.describe("Dockerfile Security", () => {
        test("Dockerfile has HA labels and security essentials", async () => {
            const fs = await import("node:fs/promises");
            const path = await import("node:path");
            const dockerPath = path.resolve(
                path.dirname(new URL(import.meta.url).pathname),
                "../../meitheal-hub/Dockerfile"
            );
            const content = await fs.readFile(dockerPath, "utf-8");

            expect(content).toContain('LABEL io.hass.type="addon"');
            expect(content).toContain("FROM ${BUILD_FROM}");
            expect(content).toContain("mkdir -p /data");

            expect(content).toContain("addgroup -S -g 10001 meitheal")
            expect(content).toContain("-u 10001 -G meitheal meitheal")
            const startup = await fs.readFile(path.join(path.dirname(dockerPath), "run.sh"), "utf-8")
            expect(startup).toContain("s6-setuidgid meitheal node scripts/migrate.mjs")
            expect(startup).toContain("s6-setuidgid meitheal node scripts/serve.mjs")

            // HEALTHCHECK for Supervisor watchdog integration
            expect(content).toContain("HEALTHCHECK");
        });
    });
});
