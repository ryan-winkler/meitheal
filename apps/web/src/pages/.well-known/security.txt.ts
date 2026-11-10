/**
 * RFC 9116 security.txt
 * GET /.well-known/security.txt
 *
 * Machine-readable security contact and policy per https://securitytxt.org
 * HA addon context: accessible via ingress proxy.
 *
 * @domain infrastructure
 * @bounded-context security
 */
import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
  const text = `# Meitheal Hub — Security Contact
# https://securitytxt.org / RFC 9116

Contact: https://github.com/ryan-winkler/meitheal/security/advisories
Expires: 2027-03-01T00:00:00.000Z
Preferred-Languages: en, ga
Canonical: https://github.com/ryan-winkler/meitheal/.well-known/security.txt
Policy: https://github.com/ryan-winkler/meitheal/security/policy
`;

  return new Response(text.trim(), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
};
