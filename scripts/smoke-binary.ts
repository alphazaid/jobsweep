#!/usr/bin/env bun
// Exercises the compiled binary end to end (no Bun on the target): PDF text extraction,
// prompt files embedded in the executable, the interview gates, rank caching, and the UI.
// Usage: bun run scripts/smoke-binary.ts dist/jobsweep-<version>-<target>
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const bin = process.argv[2]
if (!bin) {
  console.error("usage: bun run scripts/smoke-binary.ts <path-to-binary>")
  process.exit(2)
}

interface ChatBody {
  messages: Array<{ role: string; content: string }>
}
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as ChatBody
    const system = body.messages[0]?.content ?? ""
    const users = body.messages.filter((m) => m.role === "user").length
    let text = "{}"
    if (/candidate profile for their job search/.test(system)) text = users <= 1 ? JSON.stringify({ ask: "Comp floor? [200k]" }) : JSON.stringify({ done: true })
    else if (/Write the candidate profile/.test(system)) {
      const sawPdf = body.messages.some((m) => /PDF RESUME MARKER/.test(m.content))
      text = JSON.stringify({ candidate: `## Now\nSWE. Resume seen: ${sawPdf}.`, profile: { minTc: 200000 }, unknowns: [] })
    } else if (/reviewing job postings/.test(system)) {
      const ids = [...(body.messages[1]?.content ?? "").matchAll(/^id: (.+)$/gm)].map((m) => m[1]!)
      text = JSON.stringify({ results: ids.map((id) => ({ id, fit: 4, reason: `ok ${id}`, dealbreakers: [], emphasize: [] })) })
    }
    return Response.json({ choices: [{ message: { content: text } }] })
  },
})

const home = mkdtempSync(join(tmpdir(), "jobsweep-bin-"))
mkdirSync(join(home, "digests"))
writeFileSync(join(home, "profile.json"), JSON.stringify({ cities: ["New York, NY"], sources: ["greenhouse"], model: "openai:scripted" }))
// A minimal one-page PDF whose only text is the marker the scripted model looks for.
const text = "PDF RESUME MARKER Jane Doe Software Engineer"
const objs = [
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
  `<< /Length ${text.length + 40} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]
let pdf = "%PDF-1.4\n"
const offsets: number[] = []
objs.forEach((o, i) => {
  offsets.push(pdf.length)
  pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
})
const xref = pdf.length
pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
writeFileSync(join(home, "resume.pdf"), Buffer.from(pdf, "latin1"))
writeFileSync(
  join(home, "digests", "last-search.json"),
  JSON.stringify({
    date: "2026-09-02",
    params: { cities: ["New York, NY"], minTc: 200000, maxYoe: 3, days: 14 },
    jobs: [{ id: "greenhouse:acme:1", source: "greenhouse", sourceId: "acme:1", title: "Software Engineer", company: "Acme", location: "New York, NY", locations: [], workMode: null, url: "https://example.com/1", postedAt: "2026-09-01", salary: null, yoeMin: 2, level: "mid", description: "Go.", fit: null, ai: null }],
    carriedIds: [],
  }),
)

const env = { ...process.env, JOBSWEEP_HOME: home, OPENAI_BASE_URL: `http://127.0.0.1:${server.port}/v1`, OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", JOBSWEEP_MODEL: "" }
async function run(args: string[], stdin: string): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn([bin!, ...args], { stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe", env })
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  return { code, out, err }
}
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
  if (!ok) process.exitCode = 1
}

try {
  const i = await run(["interview", "--resume", join(home, "resume.pdf"), "--no-lifeos"], "y\n200k\ny\ny\n")
  check(i.code === 0, `interview exits 0 (${i.err.trim().slice(0, 120)})`)
  check(/resume \(resume\.pdf\)/.test(i.out), "PDF listed as a source")
  check(/Resume seen: true/.test(i.out), "PDF text reached the model (unpdf works inside the binary)")
  check(readFileSync(join(home, "candidate.md"), "utf8").includes("Resume seen: true"), "candidate.md written after accept")
  const r = await run(["rank", "-f", "plain"], "")
  check(r.code === 0 && /\[4\/5 apply\]/.test(r.out), "rank scores via the embedded prompt")
  const u = await run(["ui"], "")
  check(u.code === 0 && readFileSync(u.out.split("\n")[0]!, "utf8").includes("ok greenhouse:acme:1"), "ui carries the review")
} finally {
  server.stop(true)
  rmSync(home, { recursive: true, force: true })
}
