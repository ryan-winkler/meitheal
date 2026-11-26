/**
 * Canonical Routines API endpoint (/api/routines).
 * Delegates directly to the shared routine template route handlers (DRY)
 * while /api/habits remains active for backwards compatibility.
 *
 * @domain domain-tasks (routines bounded context)
 */
export { GET, POST } from "./habits"
