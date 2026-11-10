import { BlockList, isIP } from "node:net"

// Reject special-purpose networks, including address space shared by carriers.
const restricted = new BlockList()
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.31.196.0", 24], ["192.52.193.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["192.175.48.0", 24], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  restricted.addSubnet(address, prefix)
}

const ipv6GlobalUnicast = new BlockList()
ipv6GlobalUnicast.addSubnet("2000::", 3, "ipv6")
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["2620:4f:8000::", 48], ["3fff::", 20],
] as const) {
  restricted.addSubnet(address, prefix, "ipv6")
}

export function isPublicPreviewAddress(address: string, family: number): boolean {
  if (address.includes("%") || isIP(address) !== family) return false
  if (family === 4) return !restricted.check(address)
  return family === 6
    && ipv6GlobalUnicast.check(address, "ipv6")
    && !restricted.check(address, "ipv6")
}

export function previewHostname(url: URL): string | undefined {
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return
  const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1")
  const family = isIP(hostname)
  if (family) return isPublicPreviewAddress(hostname, family) ? hostname : undefined

  const name = hostname.replace(/\.$/, "")
  if (!name.includes(".") || /\.(?:local|localhost|internal)$/.test(name) || name.endsWith(".home.arpa") || name === "home.arpa") return
  return hostname
}
