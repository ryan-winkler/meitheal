import { execFileSync, fork } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))

function sendOversizedChunks(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "feedback-fixture=member" },
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

test("verified comment owners can edit and delete without claiming other comments", async ({ request }) => {
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
  let server: ReturnType<typeof fork> | undefined
  try {
    execFileSync(process.execPath, ["scripts/migrate.mjs"], { cwd: web, env })
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
    server = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const child = server
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const ingress = origin + info.configuredPath
    const headers = (role: string) => ({ cookie: `feedback-fixture=${role}` })
    const comments = `/api/tasks/${id}/comments`
    const beforeEdits = await request.get(ingress + comments, { headers: headers("member") })
    expect(beforeEdits.status()).toBe(200)
    expect(beforeEdits.headers()["cache-control"]).toBe("no-store")
    expect((await beforeEdits.json()).comments).toEqual([{
      id: expect.any(Number),
      task_id: id,
      content: "Existing comment",
      author: legacyAuthor,
      created_at: "2024-03-15 08:00:00",
      can_manage: false,
    }])

    const tokenResponse = await request.post(ingress + "/api/agent-tokens", {
      headers: headers("admin"),
      data: { name: "Test automation", scopes: ["tasks:write"] },
    })
    expect(tokenResponse.status()).toBe(201)
    const { token, id: automationTokenId } = await tokenResponse.json()
    const replacement = await request.post(ingress + "/api/agent-tokens", {
      headers: headers("admin"),
      data: { name: "Test automation", scopes: ["tasks:write"] },
    })
    expect(replacement.status()).toBe(201)
    const { token: replacementToken } = await replacement.json()
    const reader = await request.post(ingress + "/api/agent-tokens", {
      headers: headers("admin"),
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

    const automation = await request.post(origin + comments, {
      headers: { authorization: `Bearer ${token}` },
      data: { content: "Automation note", author: "Fake author" },
    })
    expect(automation.status()).toBe(201)
    const automationComment = await automation.json()
    expect(automationComment).toMatchObject({ content: "Automation note", author: "Automation: Test automation" })

    const forged = await request.post(origin + comments, {
      headers: { "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" },
      data: { content: "Direct forgery" },
    })
    expect(forged.status()).toBe(401)
    expect((await request.post(ingress + comments, {
      headers: headers("old"),
      data: { content: "Unverified ingress user" },
    })).status()).toBe(403)
    expect(await sendOversizedChunks(ingress + comments)).toBe(413)
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
    expect(initial.headers()["cache-control"]).toBe("no-store")
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
    const automationHeaders = { authorization: `Bearer ${token}` }
    expect((await request.get(automationItem, { headers: automationHeaders })).status()).toBe(403)
    const changeAutomationScopes = async (scopes: string[]) => {
      const response = await request.patch(ingress + "/api/agent-tokens", {
        headers: headers("admin"),
        data: { id: automationTokenId, scopes },
      })
      expect(response.status()).toBe(200)
    }
    await changeAutomationScopes(["tasks:read"])
    const readOnlyOwner = await request.get(origin + comments, { headers: automationHeaders })
    expect(readOnlyOwner.status()).toBe(200)
    expect((await readOnlyOwner.json()).comments.at(-1)).toEqual({ ...automationComment, can_manage: false })
    expect((await request.delete(automationItem, { headers: automationHeaders })).status()).toBe(403)
    await changeAutomationScopes(["tasks:read", "tasks:write"])
    const readWriteOwner = await request.get(origin + comments, { headers: automationHeaders })
    expect(readWriteOwner.status()).toBe(200)
    expect((await readWriteOwner.json()).comments.at(-1)).toEqual({ ...automationComment, can_manage: true })
    const readerHeaders = { authorization: `Bearer ${readerToken}` }
    const automationRead = await request.get(automationItem, { headers: readerHeaders })
    expect(automationRead.status()).toBe(200)
    expect(await automationRead.json()).toEqual(automationComment)
    const readOnlyEdit = await request.patch(automationItem, { headers: readerHeaders, data: { content: "Cannot write" } })
    expect(readOnlyEdit.status()).toBe(403)
    const replacementEdit = await request.patch(automationItem, {
      headers: { authorization: `Bearer ${replacementToken}` },
      data: { content: "Claim by name" },
    })
    expect(replacementEdit.status()).toBe(404)
    const editedAutomation = await request.patch(automationItem, {
      headers: automationHeaders,
      data: { content: "Edited automation note" },
    })
    expect(editedAutomation.status()).toBe(200)
    expect(await editedAutomation.json()).toEqual({ ...automationComment, content: "Edited automation note" })
    expect((await request.delete(automationItem, { headers: { ...automationHeaders, "content-type": "application/json" } })).status()).toBe(204)

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
    expect(await afterDelete.json()).toEqual({ comments: [] })
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit")
      server.kill()
      await exited
    }
    await rm(work, { recursive: true, force: true })
  }
})

test("a failed comment post keeps the draft for retry in the task panel", async ({ page, request, baseURL }) => {
  test.skip(!process.env.E2E_BASE_URL, "Requires a disposable local Meitheal server")
  const origin = new URL(baseURL!).origin
  const task = await request.post("/api/tasks", { headers: { origin }, data: { title: "Comment draft fixture" } })
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
