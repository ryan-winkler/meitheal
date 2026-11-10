import { fork } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, test, type APIResponse } from "@playwright/test"

const web = fileURLToPath(new URL("../../apps/web", import.meta.url))
const fixture = fileURLToPath(new URL("../scripts/feedback-ingress-fixture.mjs", import.meta.url))
const sessionCookie = (role: string) => ({ cookie: `feedback-fixture=${role}` })

async function assertPrivate(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status)
  expect(response.headers()["cache-control"]).toBe("private, no-store")
  expect(response.headers()["idempotency-key-status"]).toBeUndefined()
}

function sendOversizedChunks(url: string): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const client = httpRequest(url, { method: "POST", headers: { ...sessionCookie("member"), "content-type": "application/json" } }, response => {
      response.resume()
      resolve(response.statusCode)
    })
    client.setTimeout(5000, () => client.destroy(new Error("Reaction request timed out")))
    client.on("error", reject)
    client.write('{"content":"')
    client.write("a".repeat(1024))
    client.end('"}')
  })
}

test("reaction API protects identity, bounds requests, and keeps task and comment reactions independent", async ({ request }) => {
  test.skip(process.env.MEITHEAL_TEST_BROWSER !== "1", "Requires a built App and the ingress fixture")
  const work = await mkdtemp(join(tmpdir(), "meitheal-reactions-"))
  const file = join(work, "meitheal.db")
  const db = new DatabaseSync(file)
  const env = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    SUPERVISOR_TOKEN: "reaction-fixture-only",
    HA_BASE_URL: "http://127.0.0.1:1",
    MEITHEAL_DB_URL: `file:${file}`,
    MEITHEAL_INGRESS_FIXTURE_PORT: process.env.MEITHEAL_REACTIONS_TEST_PORT,
  }

  let child: ReturnType<typeof fork> | undefined
  try {
    child = fork(fixture, { cwd: web, env, stdio: ["ignore", "ignore", "inherit", "ipc"] })
    const [info] = await Promise.race([
      once(child, "message", { signal: AbortSignal.timeout(10_000) }),
      once(child, "exit").then(([code]) => { throw new Error(`Ingress fixture exited with ${code}`) }),
    ])
    const origin = `http://127.0.0.1:${info.port}`
    const ingress = origin + info.configuredPath
    const session = (role: string) => ({ ...sessionCookie(role), origin, "sec-fetch-site": "same-origin" })
    const member = session("member")
    const admin = session("admin")
    const oldUser = session("old")
    const createTask = async (title: string) => {
      const response = await request.post(ingress + "/api/tasks", { headers: member, data: { title } })
      expect(response.status()).toBe(201)
      return String((await response.json()).id)
    }
    const taskId = await createTask("Reaction target")
    const otherId = await createTask("Wrong parent")
    const taskPath = `/api/tasks/${taskId}`
    const card = ingress + taskPath + "/reactions"
    const commentResponse = await request.post(ingress + taskPath + "/comments", {
      headers: member, data: { content: "Comment target" },
    })
    expect(commentResponse.status()).toBe(201)
    const { id: commentId } = await commentResponse.json()
    const commentPath = `${taskPath}/comments/${commentId}`
    const comment = ingress + commentPath + "/reactions"
    const wrongComment = ingress + `/api/tasks/${otherId}/comments/${commentId}/reactions`
    const countsPath = "/api/tasks/reaction-counts"
    const counts = ingress + countsPath + `?ids=${taskId},${otherId},missing,${taskId}`
    const taskState = () => db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId)
    const before = taskState()

    for (const path of [card, comment, counts]) {
      await assertPrivate(await request.get(path.slice(ingress.length), {
        headers: { "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" },
      }), 403)
      await assertPrivate(await request.get(path, { headers: oldUser }), 403)
      await assertPrivate(await request.get(path, { headers: { cookie: "" } }), 403)
    }
    expect((await request.get(origin + taskPath + "/reactions", {
      headers: { "x-remote-user-id": "fixture-admin", "x-remote-user-groups": "system-admin" },
    })).status()).toBe(401)
    for (const url of [card, comment]) {
      const empty = await request.get(url, { headers: member })
      await assertPrivate(empty, 200)
      expect(await empty.json()).toEqual({ reactions: [], next_cursor: null, can_react: true })
    }
    await assertPrivate(await request.get(wrongComment, { headers: member }), 404)
    await assertPrivate(await request.post(wrongComment, { headers: member, data: { content: "👍" } }), 404)
    expect(() => db.prepare(
      "INSERT INTO task_reactions (task_id, comment_id, owner_key, content, author) VALUES (?, ?, 'x', '👍', 'x')",
    ).run(otherId, commentId)).toThrow(/FOREIGN KEY/)

    const retryHeaders = { ...member, "idempotency-key": "fixed-reaction-retry-key" }
    const attempts = await Promise.all(Array.from({ length: 5 }, () =>
      request.post(card, { headers: retryHeaders, data: { content: "  Cafe\u0301 👍 ", author: "Forged" } })))
    for (const response of attempts) await assertPrivate(response, 201)
    const rows = await Promise.all(attempts.map(response => response.json()))
    expect(rows.every(row => row.id === rows[0].id)).toBe(true)
    expect(rows[0]).toEqual({
      id: expect.any(Number), content: "Café 👍",
      author: expect.stringMatching(/^Home Assistant member · [a-f0-9]{10}$/), can_manage: true,
    })

    const other = await request.post(card, { headers: admin, data: { content: "Café 👍" } })
    await assertPrivate(other, 201)
    expect((await other.json()).author).not.toBe(rows[0].author)
    const memberComment = await request.post(comment, { headers: member, data: { content: "👩🏽‍💻" } })
    await assertPrivate(memberComment, 201)
    const commentItem = comment + "/" + (await memberComment.json()).id
    await assertPrivate(await request.post(comment, { headers: admin, data: { content: "👩🏽‍💻" } }), 201)
    await assertPrivate(await request.delete(commentItem, { headers: admin }), 404)
    await assertPrivate(await request.delete(commentItem, { headers: member }), 204)

    const counted = await request.get(counts, { headers: member })
    await assertPrivate(counted, 200)
    expect(await counted.json()).toEqual({ counts: { [taskId]: 2 } })
    const owned = await request.get(card, { headers: member })
    await assertPrivate(owned, 200)
    expect((await owned.json()).reactions.map((row: { can_manage: boolean }) => row.can_manage)).toEqual([false, true])
    const item = card + "/" + rows[0].id
    await assertPrivate(await request.delete(item, { headers: admin }), 404)
    await assertPrivate(await request.delete(comment + "/" + rows[0].id, { headers: member }), 404)
    await assertPrivate(await request.delete(item, { headers: retryHeaders }), 204)
    await assertPrivate(await request.delete(item, { headers: retryHeaders }), 404)
    const addedAgain = await request.post(card, { headers: retryHeaders, data: { content: "  Cafe\u0301 👍 ", author: "Forged" } })
    await assertPrivate(addedAgain, 201)
    expect((await addedAgain.json()).id).not.toBe(rows[0].id)

    for (const content of ["", "👍".repeat(17), "split\nline", "\ud800", "\u202eABC", null]) {
      await assertPrivate(await request.post(card, { headers: member, data: { content } }), 400)
    }
    await assertPrivate(await request.post(card, { headers: member, data: "plain text" }), 415)
    expect(await sendOversizedChunks(card)).toBe(413)
    for (const query of ["cursor=-1", "cursor=01", "cursor=1&cursor=2", "cursor=9007199254740992"]) {
      await assertPrivate(await request.get(card + "?" + query, { headers: member }), 400)
    }
    for (const query of ["", "?ids=a,,b", "?ids=a&ids=b", "?ids=" + Array.from({ length: 101 }, (_, i) => i).join(",")]) {
      await assertPrivate(await request.get(ingress + countsPath + query, { headers: member }), 400)
    }

    const issueToken = async (scopes: string[]) => {
      const response = await request.post(ingress + "/api/agent-tokens", { headers: admin, data: { name: "Fixture", scopes } })
      expect(response.status()).toBe(201)
      return { authorization: `Bearer ${(await response.json()).token}` }
    }
    const reader = await issueToken(["tasks:read", "mcp:execute"])
    const writer = await issueToken(["tasks:write", "mcp:execute"])
    const robot = await request.post(origin + taskPath + "/reactions", { headers: writer, data: { content: "🤖" } })
    await assertPrivate(robot, 201)
    expect(await robot.json()).toMatchObject({ author: "Automation: Fixture", can_manage: true })
    const readOnly = await request.get(origin + taskPath + "/reactions", { headers: reader })
    await assertPrivate(readOnly, 200)
    expect(await readOnly.json()).toMatchObject({
      can_react: false, reactions: [expect.objectContaining({ can_manage: false }), expect.objectContaining({ can_manage: false }),
        expect.objectContaining({ can_manage: false })],
    })
    expect((await request.post(origin + taskPath + "/reactions", { headers: reader, data: { content: "Denied" } })).status()).toBe(403)
    expect((await request.get(origin + taskPath + "/reactions", { headers: writer })).status()).toBe(403)

    const tools = async (headers: Record<string, string>) => {
      const response = await request.post(origin + "/api/mcp", {
        headers, data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      })
      expect(response.status()).toBe(200)
      return (await response.json()).result.tools.map((tool: { name: string }) => tool.name)
    }
    const readTools = await tools(reader)
    const writeTools = await tools(writer)
    expect(readTools).toEqual(expect.arrayContaining(["getTaskReactions", "getTaskCommentReactions", "getTaskReactionCounts"]))
    expect(readTools).not.toContain("addTaskReaction")
    expect(writeTools).toEqual(expect.arrayContaining(["addTaskReaction", "deleteTaskReaction", "addTaskCommentReaction", "deleteTaskCommentReaction"]))
    expect(writeTools).not.toContain("getTaskReactions")

    const call = async (headers: Record<string, string>, name: string, args: Record<string, unknown>) => {
      const response = await request.post(origin + "/api/mcp", {
        headers, data: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } },
      })
      expect(response.status()).toBe(200)
      return response.json()
    }
    const mcpAdded = await call(writer, "addTaskCommentReaction", { id: taskId, commentId, content: "MCP reaction" })
    const mcpReaction = JSON.parse(mcpAdded.result.content[0].text)
    expect(mcpReaction).toMatchObject({ content: "MCP reaction", can_manage: true })
    const mcpRead = await call(reader, "getTaskCommentReactions", { id: taskId, commentId })
    expect(JSON.parse(mcpRead.result.content[0].text)).toMatchObject({
      can_react: false, reactions: [expect.objectContaining({ content: "MCP reaction", can_manage: false }),
        expect.objectContaining({ content: "👩🏽‍💻", can_manage: false })],
    })
    const mcpRemoved = await call(writer, "deleteTaskCommentReaction", { id: taskId, commentId, reactionId: mcpReaction.id })
    expect(mcpRemoved.result.isError).not.toBe(true)

    const seed = db.prepare("INSERT INTO task_reactions (task_id, owner_key, content, author) VALUES (?, ?, '🎉', 'Fixture')")
    for (let i = 0; i < 50; i += 1) seed.run(taskId, `fixture-owner-${i}`)
    const first = await (await request.get(card, { headers: member })).json()
    const next = await (await request.get(card + "?cursor=" + first.next_cursor, { headers: member })).json()
    expect(first.reactions).toHaveLength(50)
    expect(next.reactions).toHaveLength(3)
    expect(next.next_cursor).toBeNull()
    const ids = [...first.reactions, ...next.reactions].map((row: { id: number }) => row.id)
    expect(new Set(ids).size).toBe(53)
    expect(ids).toEqual([...ids].sort((a, b) => b - a))
    expect(taskState()).toEqual(before)

    expect((await request.delete(ingress + commentPath, { headers: member })).status()).toBe(204)
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_reactions WHERE comment_id = ?").get(commentId)?.count).toBe(0)
    await assertPrivate(await request.get(comment, { headers: member }), 404)
    expect((await request.delete(ingress + taskPath, { headers: member })).ok()).toBe(true)
    expect(db.prepare("SELECT COUNT(*) AS count FROM task_reactions WHERE task_id = ?").get(taskId)?.count).toBe(0)
    await assertPrivate(await request.get(card, { headers: member }), 404)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit")
      child.kill()
      await exited
    }
    db.close()
    await rm(work, { recursive: true, force: true })
  }
})
