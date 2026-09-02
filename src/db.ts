import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DB_PATH } from "./paths.ts"
import type { FeedCache } from "./providers/provider.ts"
import type { Job } from "./types.ts"

export class Store implements FeedCache {
  private db: Database

  /** `now` is injectable so tests can move the clock instead of sleeping. */
  constructor(
    path = DB_PATH(),
    readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS feeds (
        key TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        body TEXT NOT NULL
      );
    `)
    // Nothing reads a cache row older than the longest TTL (LinkedIn details, 14 d); drop them so the file stays small.
    this.db.query("DELETE FROM feeds WHERE fetched_at < ?").run(this.now() - 15 * 86_400_000)
    // Board rows from before title-gated caching used bare `source:slug` keys and held whole raw feeds (hundreds of MB).
    // Nothing reads them now; drop them and reclaim the space once.
    const legacy = this.db.query("DELETE FROM feeds WHERE key GLOB '[a-z]*:*' AND key NOT LIKE '%:%:%' AND key NOT LIKE 'linkedin:%'").run()
    if (legacy.changes > 0) this.db.exec("VACUUM")
  }

  /** Drop every cached feed/detail (postings and their seen-dates are kept) and reclaim the space. */
  clearCache(): void {
    this.db.exec("DELETE FROM feeds; VACUUM;")
  }

  sizeBytes(): number {
    const { page_count } = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()!
    const { page_size } = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!
    return page_count * page_size
  }

  get(key: string, maxAgeMs: number): string | null {
    const row = this.db.query<{ body: string; fetched_at: number }, [string]>("SELECT body, fetched_at FROM feeds WHERE key = ?").get(key)
    return row && this.now() - row.fetched_at <= maxAgeMs ? row.body : null
  }

  set(key: string, body: string): void {
    this.db.query("INSERT OR REPLACE INTO feeds (key, fetched_at, body) VALUES (?, ?, ?)").run(key, this.now(), body)
  }

  /** Record every job from this run; returns the ids seen for the first time. */
  record(jobs: Job[]): Record<string, true> {
    const now = this.now()
    const fresh: Record<string, true> = {}
    const find = this.db.query<{ id: string }, [string]>("SELECT id FROM jobs WHERE id = ?")
    const upsert = this.db.query(
      "INSERT INTO jobs (id, first_seen, last_seen, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, json = excluded.json",
    )
    this.db.transaction(() => {
      for (const j of jobs) {
        if (!find.get(j.id)) fresh[j.id] = true
        upsert.run(j.id, now, now, JSON.stringify(j))
      }
    })()
    return fresh
  }

  job(id: string): Job | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM jobs WHERE id = ?").get(id)
    return row ? (JSON.parse(row.json) as Job) : null
  }

  /** Jobs whose id starts with `prefix` and that some run has seen since `sinceMs`. */
  recent(prefix: string, sinceMs: number): Job[] {
    return this.db
      .query<{ json: string }, [string, number]>("SELECT json FROM jobs WHERE id LIKE ? AND last_seen >= ?")
      .all(`${prefix}%`, sinceMs)
      .map((r) => JSON.parse(r.json) as Job)
  }

  /** Forget a posting (it was found closed/removed at its source). */
  remove(id: string): void {
    this.db.query("DELETE FROM jobs WHERE id = ?").run(id)
  }

  close(): void {
    this.db.close()
  }
}
