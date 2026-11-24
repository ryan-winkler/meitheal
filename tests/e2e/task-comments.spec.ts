import { execFileSync, fork } from "../helpers/isolated-process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test, type APIRequestContext } from "@playwright/test"
import { openDatabase } from "../../apps/web/scripts/database-client.mjs"
import { enrollCurrentOwnedLegacyFixture } from "../helpers/current-legacy-fixture"
import { prepareTaskBoardPredecessor } from "../scripts/task-board-predecessor"
import { currentBoardWriteHeaders } from "../helpers/current-board-http"

// This spec injects a failed comment response with Playwright request routing.
test.use({ serviceWorkers: "block" })

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

function sendOversizedChunks(url: string, proof: Record<string, string>): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(url, {
      method: "POST",
      headers: { ...proof, "content-type": "application/json", cookie: "feedback-fixture=member" },
    }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    client.setTimeout(5000, () => client.destroy(new Error("Comment request timed out")))
    client.on("error", reject)
    client.write('{"content":"')
    for (let index = 0; index < 9; index += 1) client.write("a".repeat(4096))
    client.end('"}')
  })
}

test("verified comment owners can edit and delete without claiming other comments", async ({ request, playwright }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and the ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-comments-"))
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    SUPERVISOR_TOKEN: "comment-fixture-only",
    MEITHEAL_ACTIVE_MEMBER_FIXTURE: "1",
    HA_BASE_URL: "http://127.0.0.1:1",
    MEITHEAL_DB_URL: `file:${join(work, "meitheal.db")}`,
  }
  const id = "legacy-comment-task"
  const legacyAuthor = `Home Assistant member · ${createHash("sha256").update("comment-author:fixture-member").digest("hex").slice(0, 10)}`
  let native!: APIRequestContext
  let server: ReturnType<typeof fork> | undefined
  let custodyDirectory: string | undefined
  try {
    const predecessor = openDatabase(env.MEITHEAL_DB_URL)
    try {
      await prepareTaskBoardPredecessor(predecessor)
    } finally {
      predecessor.close()
    }
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { createClient } from "@libsql/client"
      const client = createClient({ url: process.env.MEITHEAL_DB_URL })
      await client.execute("DROP TRIGGER comments_stall_burst")
      await client.execute("ALTER TABLE comments DROP COLUMN owner_key")
      const [id, author] = process.argv.slice(1)
      await client.execute({
        sql: "INSERT INTO tasks (id, title, idempotency_key, request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        args: [id, "Existing task", id, id, 1710496800000, 1710496800000],
      })
      await client.execute({
        sql: "INSERT INTO comments (task_id, content, author, created_at) VALUES (?, ?, ?, ?)",
        args: [id, "Existing comment", author, "2024-03-15 08:00:00"],
      })
      client.close()
    `, id, legacyAuthor], { cwd: web, env })
    custodyDirectory = (await enrollCurrentOwnedLegacyFixture({
      database: env.MEITHEAL_DB_URL.slice(5), markerPath: env.MEITHEAL_DB_URL.slice(5) + ".board-grants.json",
      provenance: "created-in-this-test-and-never-restored",
    })).custodyDirectory
    server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const child = server
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const ingress = origin + info.configuredPath
    const proofs = new Map(await Promise.all(["admin", "member"].map(async role => [role,
      await currentBoardWriteHeaders(request, "household", { origin, cookie: `feedback-fixture=${role}` }, ingress)] as const)))
    const headers = (role: string) => proofs.get(role) ?? ({ cookie: `feedback-fixture=${role}` })
    native = await playwright.request.newContext({ extraHTTPHeaders: {} })
    const comments = `/api/tasks/${id}/comments`
    const beforeEdits = await request.get(ingress + comments, { headers: headers("member") })
    expect(beforeEdits.status()).toBe(200)
    expect(beforeEdits.headers()["cache-control"]).toBe("private, no-store")
    expect((await beforeEdits.json()).comments).toEqual([{
      id: expect.any(Number),
      task_id: id,
      content: "Existing comment",
      author: legacyAuthor,
      created_at: "2024-03-15 08:00:00",
      can_manage: false,
    }])

    const tokenResponse = await request.post(ingress + "/api/agent-tokens", {
      headers: { ...headers("admin"), origin },
      data: { name: "Test automation", scopes: ["tasks:write"] },
    })
    expect(tokenResponse.status()).toBe(201)
    const { token, id: automationTokenId } = await tokenResponse.json()
    const replacement = await request.post(ingress + "/api/agent-tokens", {
      headers: { ...headers("admin"), origin },
      data: { name: "Test automation", scopes: ["tasks:write"] },
    })
    expect(replacement.status()).toBe(201)
    const { token: replacementToken } = await replacement.json()
    const reader = await request.post(ingress + "/api/agent-tokens", {
      headers: { ...headers("admin"), origin },
      data: { name: "Comment reader", scopes: ["tasks:read"] },
    })
    expect(reader.status()).toBe(201)
    const { token: readerToken } = await reader.json()

    const attempts = Array.from({ length: 12 }, (_, index) => {
      const role = index % 2 === 0 ? "admin" : "member"
      return { role, content: `comment number ${index}` }
    })
    const receipts = await Promise.all(attempts.map(async ({ role, content }) => {
      const response = await request.post(ingress + comments, {
        headers: { ...headers(role), "x-remote-user-id": "forged-id" },
        data: { content: `<script>discard()</script>${content}`, author: "Fake author" },
      })
      expect(response.status()).toBe(201)
      const comment = await response.json()
      expect(comment).toEqual({
        id: expect.any(Number),
        task_id: id,
        content,
        author: expect.stringMatching(/^Home Assistant member · [a-f0-9]{10}$/),
        created_at: expect.any(String),
      })
      return { comment, role }
    }))
    expect(new Set(receipts.map(({ comment }) => comment.id)).size).toBe(attempts.length)
    const names = receipts.reduce<Record<string, Set<string>>>((groups, { comment, role }) => {
      (groups[role] ??= new Set()).add(comment.author)
      return groups
    }, {})
    expect(names.member?.size).toBe(1)
    expect(names.admin?.size).toBe(1)
    expect([...names.member ?? []]).not.toEqual([...names.admin ?? []])

    const automation = await native.post(origin + comments, {
      headers: { authorization: `Bearer ${token}`, "x-meitheal-board-id": "household" },
      data: { content: "Automation note", author: "Fake author" },
    })
    expect(automation.status()).toBe(201)
    const automationComment = await automation.json()
    expect(automationComment).toMatchObject({ content: "Automation note", author: "Automation: Test automation" })

    const forged = await native.post(origin + comments, {
      headers: { "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" },
      data: { content: "Direct forgery" },
    })
    expect(forged.status()).toBe(401)
    expect((await request.post(ingress + comments, {
      headers: headers("old"),
      data: { content: "Unverified ingress user" },
    })).status()).toBe(403)
    expect(await sendOversizedChunks(ingress + comments, headers("member"))).toBe(413)
    expect((await request.post(ingress + comments, {
      headers: headers("member"),
      data: { content: "a".repeat(5001) },
    })).status()).toBe(400)
    expect((await request.post(ingress + comments, {
      headers: headers("member"),
      data: { content: "<script>removed()</script>" },
    })).status()).toBe(400)

    const listed = await request.get(ingress + comments, { headers: headers("member") })
    expect(listed.status()).toBe(200)
    const stored = (await listed.json()).comments
    expect(stored).toHaveLength(14)
    expect(stored[0]).toMatchObject({ content: "Existing comment", author: legacyAuthor, can_manage: false })
    expect(stored.slice(1, 13)).toEqual(receipts
      .map(({ comment, role }) => ({ ...comment, can_manage: role === "member" }))
      .sort((a, b) => a.id - b.id))
    expect(stored[13]).toEqual({ ...automationComment, can_manage: false })

    const memberComment = receipts.find(({ role }) => role === "member")!.comment
    expect(memberComment.author).toBe(legacyAuthor)
    const item = ingress + comments + "/" + memberComment.id
    const ownerHeaders = { ...headers("member"), origin, "sec-fetch-site": "same-origin" }
    const initial = await request.get(item, { headers: headers("member") })
    expect(initial.headers()["cache-control"]).toBe("private, no-store")
    expect(await initial.json()).toEqual(memberComment)
    expect((await request.get(item + "junk", { headers: headers("member") })).status()).toBe(404)
    const wrongTask = ingress + `/api/tasks/wrong-parent/comments/${memberComment.id}`
    expect((await request.patch(wrongTask, { headers: ownerHeaders, data: { content: "Wrong parent" } })).status()).toBe(404)

    const wrongOwner = await request.patch(item, {
      headers: { ...headers("admin"), origin, "x-remote-user-id": "fixture-member" },
      data: { content: "Forged owner", author: memberComment.author, owner_key: "fixture-member" },
    })
    expect(wrongOwner.status()).toBe(404)
    expect((await request.delete(item, { headers: { ...headers("admin"), origin, "sec-fetch-site": "same-origin" } })).status()).toBe(404)
    const legacyItem = ingress + comments + "/" + stored[0].id
    expect((await request.patch(legacyItem, { headers: ownerHeaders, data: { content: "Claim legacy" } })).status()).toBe(404)
    expect((await request.delete(legacyItem, { headers: ownerHeaders })).status()).toBe(404)
    expect((await request.patch(item, { headers: { ...headers("old"), origin }, data: { content: "Unverified" } })).status()).toBe(403)
    expect((await request.patch(item, { headers: ownerHeaders, data: "plain text" })).status()).toBe(415)

    const edited = await request.patch(item, {
      headers: ownerHeaders,
      data: { content: "<script>discard()</script>Edited note", author: "Fake author" },
    })
    expect(edited.status()).toBe(200)
    const updated = { ...memberComment, content: "Edited note" }
    expect(await edited.json()).toEqual(updated)
    expect(await (await request.get(item, { headers: headers("member") })).json()).toEqual(updated)

    const automationItem = origin + comments + "/" + automationComment.id
    const automationHeaders = { authorization: `Bearer ${token}`, "x-meitheal-board-id": "household" }
    expect((await native.get(automationItem, { headers: automationHeaders })).status()).toBe(403)
    const changeAutomationScopes = async (scopes: string[]) => {
      const response = await request.patch(ingress + "/api/agent-tokens", {
        headers: { ...headers("admin"), origin },
        data: { id: automationTokenId, scopes },
      })
      expect(response.status()).toBe(200)
      // A credential scope update cannot enlarge its independently approved Board grant.
      const beforeApproval = scopes.includes("tasks:write")
        ? await native.patch(automationItem, { headers: automationHeaders, data: { content: "Must wait for Board approval" } })
        : await native.get(automationItem, { headers: automationHeaders })
      expect(beforeApproval.status()).toBe(403)
      const approved = await request.patch(ingress + "/api/boards/household", {
        headers: { ...headers("admin"), origin },
        data: { action: "agent", tokenId: automationTokenId, enabled: true },
      })
      expect(approved.status(), await approved.text()).toBe(200)
    }
    await changeAutomationScopes(["tasks:read"])
    const readOnlyOwner = await native.get(origin + comments, { headers: automationHeaders })
    expect(readOnlyOwner.status()).toBe(200)
    expect((await readOnlyOwner.json()).comments.at(-1)).toEqual({ ...automationComment, can_manage: false })
    expect((await native.delete(automationItem, { headers: automationHeaders })).status()).toBe(403)
    await changeAutomationScopes(["tasks:read", "tasks:write"])
    const readWriteOwner = await native.get(origin + comments, { headers: automationHeaders })
    expect(readWriteOwner.status()).toBe(200)
    expect((await readWriteOwner.json()).comments.at(-1)).toEqual({ ...automationComment, can_manage: true })
    const readerHeaders = { authorization: `Bearer ${readerToken}`, "x-meitheal-board-id": "household" }
    const automationRead = await native.get(automationItem, { headers: readerHeaders })
    expect(automationRead.status()).toBe(200)
    expect(await automationRead.json()).toEqual(automationComment)
    const readOnlyEdit = await native.patch(automationItem, { headers: readerHeaders, data: { content: "Cannot write" } })
    expect(readOnlyEdit.status()).toBe(403)
    const replacementEdit = await native.patch(automationItem, {
      headers: { authorization: `Bearer ${replacementToken}`, "x-meitheal-board-id": "household" },
      data: { content: "Claim by name" },
    })
    expect(replacementEdit.status()).toBe(404)
    const editedAutomation = await native.patch(automationItem, {
      headers: automationHeaders,
      data: { content: "Edited automation note" },
    })
    expect(editedAutomation.status()).toBe(200)
    expect(await editedAutomation.json()).toEqual({ ...automationComment, content: "Edited automation note" })
    expect((await native.delete(automationItem, { headers: { ...automationHeaders, "content-type": "application/json" } })).status()).toBe(204)

    const [raceEdit, raceDelete] = await Promise.all([
      request.patch(item, { headers: ownerHeaders, data: { content: "Concurrent edit" } }),
      request.delete(item, { headers: ownerHeaders }),
    ])
    expect([200, 404]).toContain(raceEdit.status())
    expect(raceDelete.status()).toBe(204)
    expect((await request.get(item, { headers: headers("member") })).status()).toBe(404)

    const deleted = await request.delete(ingress + `/api/tasks/${id}`, {
      headers: { ...headers("admin"), origin, "sec-fetch-site": "same-origin" },
    })
    expect(deleted.status(), await deleted.text()).toBe(204)
    expect((await request.post(ingress + comments, {
      headers: headers("member"),
      data: { content: "Task was deleted" },
    })).status()).toBe(404)
    const afterDelete = await request.get(ingress + comments, { headers: headers("member") })
    expect(afterDelete.status()).toBe(404)
    expect(await afterDelete.json()).toMatchObject({ status: 404, detail: "This work is unavailable." })
  } finally {
    await native?.dispose()
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    if (custodyDirectory) await rm(custodyDirectory, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  }
})

test("a failed comment post keeps the draft for retry in the task panel", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const proof = await currentBoardWriteHeaders(request, "household", { origin })
  const task = await request.post("/api/tasks", { headers: proof, data: { title: "Comment draft fixture" } })
  expect(task.status()).toBe(201)
  const { id } = await task.json()
  const comments = `**/api/tasks/${id}/comments`
  await page.goto(`/tasks?open=${id}#kanban`)
  const panel = page.getByRole("dialog", { name: "Task detail: Comment draft fixture" })
  const input = panel.getByRole("textbox", { name: "Comment", exact: true })
  const submit = panel.getByRole("button", { name: "Post Comment" })
  await input.fill("Keep this draft")
  await page.route(comments, route => route.request().method() === "POST" ? route.fulfill({ status: 503 }) : route.continue())
  await submit.click()
  await expect(panel.getByText("Could not post your comment", { exact: false })).toBeVisible()
  await expect(input).toHaveValue("Keep this draft")
  await page.unroute(comments)
  await submit.click()
  await expect(panel.getByText("Keep this draft", { exact: true })).toBeVisible()
  await expect(panel.getByText("Local user", { exact: true })).toBeVisible()
  await expect(panel.getByRole("button", { name: "Edit comment" })).toHaveCount(0)
  await expect(panel.getByRole("button", { name: "Delete comment" })).toHaveCount(0)
  await expect(input).toHaveValue("")
})
