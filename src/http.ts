const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"

export interface FetchOpts {
  headers?: Record<string, string>
  timeoutMs?: number
  retries?: number
}

/**
 * GET with exponential backoff on 429/5xx. Returns null on 404 so callers can
 * treat "not found" as data (a dead board slug, a closed posting) rather than an error.
 */
export async function getText(url: string, opts: FetchOpts = {}): Promise<string | null> {
  const retries = opts.retries ?? 4
  let delay = 500
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", ...opts.headers },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    })
    if (res.status === 404) return null
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await Bun.sleep(delay + Math.random() * 400)
      delay = Math.min(delay * 2, 8_000)
      continue
    }
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return res.text()
  }
}

export async function getJson<T>(url: string, opts: FetchOpts = {}): Promise<T | null> {
  const text = await getText(url, { ...opts, headers: { Accept: "application/json", ...opts.headers } })
  if (text === null) return null
  return JSON.parse(text) as T
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i] as T)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
