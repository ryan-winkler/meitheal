import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const canaryVersion = /^[0-9a-f]{12}$/
const architectures = { amd64: "linux/amd64", aarch64: "linux/arm64" }
const channels = {
  stable: { dir: "meitheal-hub", image: "meitheal" },
  canary: { dir: "meitheal-hub-canary", image: "meitheal-canary" },
}

function fail(message) {
  throw new Error(message)
}

function channelConfig(channel) {
  if (!Object.hasOwn(channels, channel)) fail("Expected stable or canary")
  const config = channels[channel]
  const source = join(root, config.dir)
  const manifest = readFileSync(join(source, "config.yaml"), "utf8")
  const image = `ghcr.io/ryan-winkler/${config.image}-{arch}`
  const imageFields = manifest.match(/^image: .+$/gm)
  if (imageFields?.length !== 1 || imageFields[0] !== `image: "${image}"`) fail("Unexpected App image template")
  return { source, dir: config.dir, manifest, image }
}

function versionOf(manifest) {
  const fields = [...manifest.matchAll(/^version: "([^"\r\n]+)"$/gm)]
  if (fields.length !== 1) fail("Expected one quoted App version")
  return fields[0][1]
}

function releaseVersion(channel, manifest, event, ref, revision) {
  if (event !== "push" && event !== "workflow_dispatch") fail("Unexpected publication event")
  if (!/^[a-f0-9]{40}$/.test(revision)) fail("Expected a full source commit")
  if (channel === "canary") {
    if (ref !== "refs/heads/main") fail("Canary must build from main")
    return revision.slice(0, 12)
  }

  const version = versionOf(manifest)
  if (!stableVersion.test(version) || ref !== `refs/tags/v${version}`) fail("Stable tag must match the App version")
  return version
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(BigInt)
  const rightParts = right.split(".").map(BigInt)
  for (let i = 0; i < leftParts.length; i++) {
    if (leftParts[i] !== rightParts[i]) return leftParts[i] > rightParts[i] ? 1 : -1
  }
  return 0
}

function checkDestination(path, directory = false) {
  const entry = lstatSync(path, { throwIfNoEntry: false })
  if (entry && (directory ? !entry.isDirectory() : !entry.isFile())) fail("Unexpected path in App checkout")
}

function stage(channel, config, version, destination) {
  const sourceVersion = versionOf(config.manifest)
  if (channel === "stable" && (!stableVersion.test(version) || version !== sourceVersion)) fail("Stable manifest version mismatch")
  if (channel === "canary" && !canaryVersion.test(version)) fail("Invalid canary version")

  const target = resolve(destination)
  if (target === root || !existsSync(join(target, ".git"))) fail("Expected a separate App repository checkout")
  const directory = join(target, config.dir)
  const manifestPath = join(directory, "config.yaml")
  checkDestination(directory, true)
  checkDestination(manifestPath)
  checkDestination(join(directory, "translations"), true)
  if (channel === "stable" && existsSync(manifestPath)) {
    const current = versionOf(readFileSync(manifestPath, "utf8"))
    if (!stableVersion.test(current) || compareVersions(version, current) < 0) fail("Stable version would move backwards")
  }

  mkdirSync(join(directory, "translations"), { recursive: true })
  const manifest = channel === "canary"
    ? config.manifest.replace(/^version: "[^"\r\n]+"$/m, `version: "${version}"`)
    : config.manifest
  writeFileSync(manifestPath, manifest)
  for (const name of ["DOCS.md", "CHANGELOG.md", "icon.png", "logo.png", "apparmor.txt"]) {
    const source = name === "apparmor.txt"
      ? join(root, channels.stable.dir, name)
      : join(config.source, name)
    if (!lstatSync(source).isFile()) fail(`Unexpected App asset: ${name}`)
    const destination = join(directory, name)
    checkDestination(destination)
    copyFileSync(source, destination)
  }
  const translations = join(config.source, "translations")
  for (const entry of readdirSync(translations, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[\w-]+\.yaml$/.test(entry.name)) fail("Unexpected App translation")
    const destination = join(directory, "translations", entry.name)
    checkDestination(destination)
    copyFileSync(join(translations, entry.name), destination)
  }
  if (channel === "canary") {
    const destination = join(target, "repository.yaml")
    checkDestination(destination)
    copyFileSync(join(root, "repository.yaml"), destination)
  }
}

function main([command, channel, first, second, third]) {
  const config = channelConfig(channel)
  if (command === "prepare") {
    console.log(`version=${releaseVersion(channel, config.manifest, first, second, third)}`)
    return
  }
  if (command === "stage") {
    stage(channel, config, first, second)
    return
  }
  if (command === "image") {
    const arch = first
    if (!Object.hasOwn(architectures, arch)) fail("Expected amd64 or aarch64")
    const version = releaseVersion(channel, config.manifest, process.env.GITHUB_EVENT_NAME, process.env.GITHUB_REF, third)
    if (second !== version) fail("Image version does not match the release")
    const build = JSON.parse(readFileSync(join(config.source, "build.json"), "utf8"))
    const base = build.build_from[arch]
    if (!new RegExp(`^ghcr\\.io/home-assistant/${arch}-base:[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$`).test(base)) {
      fail("Invalid Home Assistant base image")
    }
    console.log(JSON.stringify({
      image: `${config.image.replace("{arch}", arch)}:${version}`,
      platform: architectures[arch],
      base,
    }))
    return
  }
  fail("Expected prepare, stage or image")
}

try {
  main(process.argv.slice(2))
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
