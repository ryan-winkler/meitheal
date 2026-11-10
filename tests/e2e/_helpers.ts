export function shouldSkipBrowserSpecs(): boolean {
  return !process.env.E2E_BASE_URL;
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
