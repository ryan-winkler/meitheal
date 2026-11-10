import { expect, test } from "@playwright/test"
import { runWithIngressTransport, type IngressTransport } from "../../apps/web/scripts/ingress-transport.mjs"
import { resolveIngressContext } from "../../apps/web/src/domains/auth/ingress"

const ingressPath = "/api/hassio_ingress/safe-token_123"
const supervisor: IngressTransport = {
  peer: "172.30.32.2",
  fromSupervisor: true,
  identityHeadersSafe: true,
  configuredPath: undefined,
}
const adminHeaders = new Headers({
  "x-ingress-path": `${ingressPath}/`,
  "x-remote-user-id": "user-id",
  "x-remote-user-groups": "system-users, system-admin",
})

test("only the wrapper's Supervisor transport establishes ingress", () => {
  expect(resolveIngressContext(adminHeaders)).toEqual({ behindIngress: false, hassIsAdmin: false })
  expect(resolveIngressContext(adminHeaders, {
    ...supervisor,
    peer: "172.30.32.99",
    fromSupervisor: false,
  })).toEqual({ behindIngress: false, hassIsAdmin: false })
  expect(resolveIngressContext(adminHeaders, supervisor)).toEqual({
    behindIngress: true,
    ingressPath,
    hassUserId: "user-id",
    hassIsAdmin: true,
  })
})

test("older or unavailable Supervisor versions do not grant user authority", () => {
  expect(resolveIngressContext(adminHeaders, { ...supervisor, identityHeadersSafe: false })).toEqual({
    behindIngress: true,
    ingressPath,
    hassIsAdmin: false,
  })
})

test("legacy identity, missing user and group lookalikes never grant administration", () => {
  const headers = new Headers({
    "x-ingress-path": ingressPath,
    "x-hass-user-id": "legacy-id",
    "x-hass-is-admin": "true",
    "x-remote-user-groups": "system-admin",
  })
  expect(resolveIngressContext(headers, supervisor)).toEqual({ behindIngress: true, ingressPath, hassIsAdmin: false })

  headers.set("x-remote-user-id", "current-user")
  headers.set("x-remote-user-groups", "custom-system-admin, system-admin-test")
  expect(resolveIngressContext(headers, supervisor)).toEqual({
    behindIngress: true, ingressPath, hassUserId: "current-user", hassIsAdmin: false,
  })

  headers.set("x-remote-user-id", "one-user, another-user")
  expect(resolveIngressContext(headers, supervisor)).toEqual({ behindIngress: true, ingressPath, hassIsAdmin: false })
})

test("the configured Supervisor path takes precedence over the request path", () => {
  const headers = new Headers({ "x-ingress-path": "/api/hassio_ingress/other-token" })
  expect(resolveIngressContext(headers, { ...supervisor, configuredPath: `${ingressPath}//` }).ingressPath)
    .toBe(ingressPath)
  expect(resolveIngressContext(headers, { ...supervisor, configuredPath: "/" }).behindIngress).toBe(false)
})

test("ingress rejects forwarding fallbacks and unsafe path syntax", () => {
  const headers = new Headers({
    "x-forwarded-prefix": ingressPath,
    "x-forwarded-uri": `${ingressPath}/tasks`,
    "x-original-uri": ingressPath,
    referer: `http://ha.internal${ingressPath}/tasks`,
  })
  expect(resolveIngressContext(headers, supervisor).behindIngress).toBe(false)

  for (const path of [
    "https://evil.example/api/hassio_ingress/token",
    "//evil.example",
    "/api/hassio_ingress/",
    "/api/hassio_ingress/../token",
    "/api/hassio_ingress/token/other",
    "/api/hassio_ingress/token?query=yes",
    "/api/hassio_ingress/token#fragment",
    "/api/hassio_ingress/token%22",
    '/api/hassio_ingress/token"><script>',
    "/api/hassio_ingress/token\\path",
    `${ingressPath}, ${ingressPath}`,
  ]) {
    headers.set("x-ingress-path", path)
    expect(resolveIngressContext(headers, supervisor), path).toEqual({ behindIngress: false, hassIsAdmin: false })
  }
})


test("trusted transport is isolated between concurrent requests", async () => {
  const trusted = runWithIngressTransport(supervisor, async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    return resolveIngressContext(adminHeaders)
  })
  const direct = runWithIngressTransport({ ...supervisor, fromSupervisor: false }, async () => {
    await new Promise<void>(resolve => setImmediate(resolve))
    return resolveIngressContext(adminHeaders)
  })

  expect((await trusted).hassIsAdmin).toBe(true)
  expect(await direct).toEqual({ behindIngress: false, hassIsAdmin: false })
  expect(resolveIngressContext(adminHeaders).behindIngress).toBe(false)
})
