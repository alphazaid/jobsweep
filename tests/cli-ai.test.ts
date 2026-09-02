import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * A stand-in OpenAI-compatible server. It routes on the system prompt so each
 * command gets a plausible scripted answer; what's under test is the CLI's
 * plumbing (config, stdin gates, files written, cache), not model quality.
 */
let server: ReturnType<typeof Bun.serve>
let home: string
let requests = 0

interface ChatBody {
  messages: Array<{ role: string; content: string }>
}

function isChatBody(v: unknown): v is ChatBody {
  return !!v && typeof v === "object" && "messages" in v && Array.isArray(v.messages)
}

function reply(body: ChatBody): string {
  const system = body.messages[0]?.content ?? ""
  const userTurns = body.messages.filter((m) => m.role === "user").length
  if (/candidate profile for their job search/.test(system)) {
    // Interview: one question, then done.
    return userTurns <= 1 ? JSON.stringify({ ask: "What comp floor are you targeting? [200k]" }) : JSON.stringify({ done: true })
  }
  if (/Write the candidate profile/.test(system)) {
    const corrected = body.messages.some((m) => /Correction from the candidate/.test(m.content))
    return JSON.stringify({
      candidate: `## Now\nSWE, 2 years, Go/TypeScript.${corrected ? " Corrected: also Java." : ""}\n## Looking for\nBackend roles in NYC.\n## Non-negotiables\n≥$200k.`,
      profile: { cities: ["New York, NY"], minTc: 200000, maxYoe: 3, skills: ["Go", "TypeScript"], remote: "include" },
      unknowns: ["visa status"],
    })
  }
  if (/reviewing job postings/.test(system)) {
    const ids = [...(body.messages[1]?.content ?? "").matchAll(/^id: (.+)$/gm)].map((m) => m[1]!)
    return JSON.stringify({ results: ids.map((id, i) => ({ id, fit: i === 0 ? 5 : 2, reason: `scripted reason for ${id}`, dealbreakers: i === 0 ? [] : ["needs 5 years"], emphasize: ["Go"] })) })
  }
  return "{}"
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requests++
      const raw: unknown = await req.json()
      if (!isChatBody(raw)) return new Response("bad body", { status: 400 })
      return Response.json({ choices: [{ message: { content: reply(raw) } }] })
    },
  })
  home = mkdtempSync(join(tmpdir(), "jobsweep-e2e-"))
  mkdirSync(join(home, "digests"), { recursive: true })
  writeFileSync(join(home, "profile.json"), JSON.stringify({ cities: ["New York, NY"], sources: ["greenhouse"], model: "openai:scripted" }))
  writeFileSync(join(home, "resume.md"), "# Jane Doe\nSoftware Engineer at Acme, 2 years. Go, TypeScript.\n")
  const jobs = ["a", "b"].map((id) => ({
    id: `greenhouse:acme:${id}`, source: "greenhouse", sourceId: `acme:${id}`, title: `Software Engineer ${id}`, company: "Acme", location: "New York, NY", locations: ["New York, NY"], workMode: null,
    url: `https://example.com/${id}`, postedAt: "2026-09-01", salary: { min: 200000, max: 250000, raw: "", kind: "parsed" }, yoeMin: 2, level: "mid", description: "Go and TypeScript backend.", fit: null, ai: null,
  }))
  writeFileSync(join(home, "digests", "last-search.json"), JSON.stringify({ date: "2026-09-02", params: { cities: ["New York, NY"], minTc: 200000, maxYoe: 3, days: 14 }, jobs, carriedIds: [] }))
})
afterAll(() => {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
})

/** Async on purpose: the scripted server runs in this process, so a blocking spawn would deadlock the CLI's model calls. */
async function cli(args: string[], stdin = ""): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    stdin: Buffer.from(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, JOBSWEEP_HOME: home, OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", JOBSWEEP_MODEL: "" },
  })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}

describe("interview → rank → ui through the CLI", () => {
  test("rank refuses without a candidate profile", async () => {
    const r = await cli(["rank"])
    expect(r.code).toBe(1)
    expect(r.err).toMatch(/jobsweep interview/)
  })

  test("interview: asks, drafts, honors 'correct', then saves only on accept and confirms profile fields", async () => {
    // answers: the one question · "c" correct · correction text · "y" accept · then the profile prompts in key order
    // (cities unchanged → not asked; remote n · minTc y · maxYoe n · skills n)
    // "y" = continue (send the listed documents to the model) · then the question, correct, accept, profile prompts
    const stdin = ["y", "200k", "c", "I also use Java", "y", "n", "y", "n", "n"].join("\n") + "\n"
    const r = await cli(["interview", "--resume", join(home, "resume.md"), "--no-lifeos"], stdin)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/What comp floor/)
    expect(r.out).toMatch(/Corrected: also Java/)
    const candidate = readFileSync(join(home, "candidate.md"), "utf8")
    expect(candidate).toContain("Corrected: also Java")
    const profile = JSON.parse(readFileSync(join(home, "profile.json"), "utf8")) as { minTc?: number; maxYoe?: number; skills?: string[] }
    expect(profile.maxYoe).toBeUndefined() // declined
    expect(profile.minTc).toBe(200000) // accepted
    expect(r.out).toMatch(/up to 20,000 characters each\) will be sent to openai:scripted \(local server at http:\/\/127\.0\.0\.1/)
  })

  test("interview: declining to send documents makes no model call", async () => {
    const before = requests
    const r = await cli(["interview", "--resume", join(home, "resume.md"), "--no-lifeos"], "n\n")
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/Nothing sent/)
    expect(requests).toBe(before)
  })

  test("interview: declining the draft saves nothing", async () => {
    rmSync(join(home, "candidate.md"), { force: true })
    const r = await cli(["interview", "--resume", join(home, "resume.md"), "--no-lifeos"], "y\n200k\nq\n")
    expect(r.code).toBe(1)
    expect(existsSync(join(home, "candidate.md"))).toBe(false)
    // restore for the next tests
    await cli(["interview", "--resume", join(home, "resume.md"), "--no-lifeos"], "y\n200k\ny\nn\nn\nn\nn\nn\nn\nn\n")
    expect(existsSync(join(home, "candidate.md"))).toBe(true)
  })

  test("rank: scores, writes reviews into last-search.json, second run is served from cache", async () => {
    const before = requests
    const r1 = await cli(["rank", "-f", "json"])
    expect(r1.code).toBe(0)
    const ranked = JSON.parse(r1.out) as Array<{ id: string; ai: { fit: number; reason: string } | null }>
    expect(ranked[0]!.ai?.fit).toBe(5)
    expect(ranked[1]!.ai?.reason).toMatch(/scripted reason/)
    const saved = JSON.parse(readFileSync(join(home, "digests", "last-search.json"), "utf8")) as { jobs: Array<{ ai: unknown }> }
    expect(saved.jobs.every((j) => j.ai)).toBe(true)
    const mid = requests
    expect(mid - before).toBe(1)
    const r2 = await cli(["rank", "-f", "plain"])
    expect(r2.code).toBe(0)
    expect(requests).toBe(mid) // no model calls
    expect(r2.out).toMatch(/\[5\/5 apply today\]/)
  })

  test("ui: page carries the AI fit chips and reasons", async () => {
    const r = await cli(["ui"])
    expect(r.code).toBe(0)
    const html = readFileSync(r.out.split("\n")[0]!, "utf8")
    expect(html).toContain('"fit":5')
    expect(html).toContain("scripted reason for")
    expect(html).toContain("needs 5 years")
  })
})
