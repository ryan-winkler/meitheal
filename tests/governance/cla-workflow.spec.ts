import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../..", import.meta.url))
const signature = "I have read the CLA Document and I hereby sign the CLA."
const head = "a".repeat(40)
const otherHead = "b".repeat(40)
const commit = { sha: head, author: { id: 10, login: "fixture-contributor" } }
const pull = { state: "open", head: { sha: head }, user: { id: 10 }, commits: 1 }
const opened = { pull_request: { number: 7, head: { sha: head } } }
const repo = "repos/fixture/meitheal"

interface Fixture {
  pr?: typeof pull
  pages?: unknown[][]
  currentHead?: string
  ledger?: unknown[]
  prompt?: string
}

function check(event: Record<string, unknown>, fixture: Fixture = {}) {
  const dir = mkdtempSync(join(tmpdir(), "meitheal-cla-"))
  const eventPath = join(dir, "event.json")
  const apiCalls = join(dir, "api-calls")
  try {
    writeFileSync(eventPath, JSON.stringify(event))
    writeFileSync(apiCalls, "")
    writeFileSync(join(dir, "gh"), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs")
const args = process.argv.slice(2)
const route = args.find(arg => arg.startsWith("repos/fixture/meitheal/"))
const fixture = JSON.parse(process.env.CLA_FIXTURE)
const input = args.includes("--input") ? ["input=" + readFileSync(0, "utf8")] : []
appendFileSync(process.env.CLA_FIXTURE_API_CALLS, JSON.stringify(args.concat(input)) + "\\n")
switch (route) {
  case "repos/fixture/meitheal/pulls/7":
    console.log(args.includes("--jq") ? fixture.currentHead : JSON.stringify(fixture.pr))
    break
  case "repos/fixture/meitheal/pulls/7/commits?per_page=100":
    if (!args.includes("--paginate") || !args.includes("--slurp")) process.exit(5)
    console.log(JSON.stringify(fixture.pages))
    break
  case "repos/fixture/meitheal/contents/signatures/version1/cla.json?ref=cla-signatures":
    console.log(JSON.stringify({
      sha: "fixture-ledger-sha",
      content: Buffer.from(JSON.stringify({ signedContributors: fixture.ledger })).toString("base64"),
    }))
    break
  case "repos/fixture/meitheal/issues/7/comments?per_page=100":
    if (!args.includes("--paginate")) process.exit(5)
    console.log(fixture.prompt)
    break
  case "repos/fixture/meitheal/contents/signatures/version1/cla.json":
  case "repos/fixture/meitheal/issues/7/comments":
  case "repos/fixture/meitheal/statuses/${head}":
    if (!args.includes("--method")) process.exit(5)
    console.log("{}")
    break
  default: process.exit(5)
}
`, { mode: 0o700 })

    const result = spawnSync("bash", [".github/scripts/check-cla.sh"], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: dir + delimiter + process.env.PATH,
        GITHUB_EVENT_NAME: event.issue ? "issue_comment" : "pull_request_target",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "fixture/meitheal",
        GITHUB_SERVER_URL: "https://github.example.test",
        GITHUB_WORKFLOW_SHA: "f".repeat(40),
        CLA_FIXTURE: JSON.stringify({
          pr: pull,
          pages: [[commit]],
          currentHead: head,
          ledger: [],
          prompt: "",
          ...fixture,
        }),
        CLA_FIXTURE_API_CALLS: apiCalls,
      },
    })
    const calls = readFileSync(apiCalls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[])
    return { status: result.status, error: result.stderr, calls, writes: calls.filter(args => args.includes("--method")) }
  } finally {
    rmSync(dir, { recursive: true })
  }
}

function comment(body: string, id = 10) {
  return {
    action: "created",
    repository: { id: 42 },
    issue: { number: 7, pull_request: {} },
    comment: {
      body, id: 101, created_at: "2026-11-09T00:00:00Z",
      user: { id, type: "User", login: "fixture-contributor" },
    },
  }
}

test("posts a signing prompt and a failing status for an unsigned contributor", () => {
  const result = check(opened)
  expect(result.error).toBe("")
  expect(result.status).toBe(0)
  expect(result.writes).toHaveLength(2)
  expect(result.writes[0]).toEqual(expect.arrayContaining([`${repo}/statuses/${head}`, "state=failure"]))
  expect(result.writes[1]).toContain(`${repo}/issues/7/comments`)
  expect(result.writes[1]?.join("\n")).toContain(signature)
  expect(check(opened, { prompt: "20" }).writes).toHaveLength(1)
})

test("records the authenticated signature once and reports success for the exact head", () => {
  const result = check(comment(signature))
  expect(result.error).toBe("")
  expect(result.status).toBe(0)
  expect(result.writes).toHaveLength(2)
  expect(result.writes[0]).toEqual(expect.arrayContaining(["PUT", `${repo}/contents/signatures/version1/cla.json`]))
  const input = result.writes[0]?.find(arg => arg.startsWith("input="))?.slice("input=".length) ?? ""
  const update = JSON.parse(input)
  expect(update).toMatchObject({ branch: "cla-signatures", sha: "fixture-ledger-sha" })
  const saved = JSON.parse(Buffer.from(update.content, "base64").toString("utf8"))
  expect(saved.signedContributors).toEqual([{
    id: 10, name: "fixture-contributor", comment_id: 101, created_at: "2026-11-09T00:00:00Z", repoId: 42, pullRequestNo: 7,
  }])
  expect(result.writes[1]).toEqual(expect.arrayContaining([`${repo}/statuses/${head}`, "state=success"]))
  for (const body of [signature, "recheck"]) {
    const repeat = check(comment(body), { ledger: saved.signedContributors })
    expect(repeat.writes).toEqual([expect.arrayContaining([`${repo}/statuses/${head}`, "state=success"])])
  }
})

test("ignores ordinary issues, inexact signatures and bot comments before any API call", () => {
  for (const event of [
    { ...comment(signature), issue: { number: 7 } },
    comment(`Quoted example: ${signature}`),
    { ...comment(signature), comment: { body: signature, user: { id: 10, type: "Bot" } } },
  ]) {
    expect(check(event)).toMatchObject({ status: 0, calls: [] })
  }
})

test("skips unrelated commenters and closed pull requests without writes", () => {
  expect(check(comment(signature, 20))).toMatchObject({ status: 0, writes: [] })
  expect(check(comment("recheck", 20))).toMatchObject({ status: 0, writes: [] })
  expect(check(comment(signature), { pr: { ...pull, state: "closed" } })).toMatchObject({ status: 0, writes: [] })
})

test("fails closed for unlinked authors, an absent opener, and incomplete commit reads", () => {
  for (const pages of [
    [[{ sha: head, author: null, committer: commit.author }]],
    [[{ ...commit, author: { id: 20, login: "fixture-other" } }]],
    [[]],
  ]) {
    expect(check(opened, { pages })).toMatchObject({
      status: 1,
      writes: [expect.arrayContaining([`${repo}/statuses/${head}`, "state=failure"])],
    })
  }
  expect(check(opened, { pr: { ...pull, commits: 251 } }).error).toContain("1 to 250 commits")
})

test("requires signatures across pages and preserves the existing exempt users", () => {
  const owner = { sha: head, author: { id: 10, login: "ryan-winkler" } }
  const contributor = { ...commit, sha: otherHead, author: { id: 20, login: "fixture-other" } }
  expect(check(opened, { pages: [[owner]] }).writes).toEqual([expect.arrayContaining(["state=success"])])
  const paged = check(opened, { pr: { ...pull, commits: 2 }, pages: [[owner], [contributor]], prompt: "20" })
  expect(paged.writes).toEqual([expect.arrayContaining(["state=failure"])])
})

test("fails without writing when the pull request advances before or during the check", () => {
  const stale = { pull_request: { number: 7, head: { sha: otherHead } } }
  expect(check(stale)).toMatchObject({ status: 1, writes: [] })
  expect(check(opened, { currentHead: otherHead })).toMatchObject({ status: 1, writes: [] })
  expect(check(comment(signature), { currentHead: otherHead })).toMatchObject({ status: 1, writes: [] })
})
