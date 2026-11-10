/** Allow a self-signed certificate only for the named development endpoint. */
export async function fetchWithDevelopmentTls(url: string, options: RequestInit): Promise<Response> {
  if (process.env.NODE_ENV !== "development" || !new URL(url).hostname.endsWith(".internal")) {
    return fetch(url, options)
  }

  const { Agent, Dispatcher1Wrapper } = await import("undici")
  const dispatcher = new Dispatcher1Wrapper(new Agent({ connect: { rejectUnauthorized: false } }))

  try {
    const init = { ...options, redirect: "error", dispatcher } as const
    return await fetch(url, init)
  } finally {
    // Close after the caller consumes or cancels the response body.
    void dispatcher.close().catch(() => dispatcher.destroy())
  }
}
