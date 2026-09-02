import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileSource, hasLifeos, lifeosSources } from "../src/context.ts"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jobsweep-ctx-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.LIFEOS_DIR
})

/** A minimal single-page PDF with one text object — enough for a text extractor, no dependency needed to write it. */
function tinyPdf(text: string): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length + 40} >>\nstream\nBT /F1 12 Tf 20 100 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let out = "%PDF-1.4\n"
  const offsets: number[] = []
  objs.forEach((o, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, "latin1")
}

describe("fileSource", () => {
  test("reads markdown and text", async () => {
    const p = join(dir, "resume.md")
    writeFileSync(p, "# Jane Doe\nSoftware Engineer, 3 years, Go and TypeScript.\n")
    const s = await fileSource(p)
    expect(s.label).toBe("resume (resume.md)")
    expect(s.text).toContain("3 years")
  })
  test("extracts text from a PDF", async () => {
    const p = join(dir, "resume.pdf")
    writeFileSync(p, tinyPdf("Jane Doe Software Engineer"))
    const s = await fileSource(p)
    expect(s.text).toContain("Jane Doe")
  })
  test("missing file and empty file fail loudly", async () => {
    await expect(fileSource(join(dir, "nope.md"))).rejects.toThrow(/not found/)
    const p = join(dir, "empty.txt")
    writeFileSync(p, "   \n")
    await expect(fileSource(p)).rejects.toThrow(/no text/)
  })
})

describe("lifeosSources", () => {
  test("absent install → nothing; present install → only filled-in files, stubs skipped", () => {
    process.env.LIFEOS_DIR = dir
    expect(hasLifeos()).toBe(false)
    expect(lifeosSources()).toEqual([])
    mkdirSync(join(dir, "LIFEOS/USER/PRINCIPAL"), { recursive: true })
    writeFileSync(join(dir, "LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md"), "# Identity\nName: Jane. Role: SWE at Acme since 2024.\n")
    writeFileSync(join(dir, "LIFEOS/USER/PRINCIPAL/RESUME.md"), "**Title:** (interview)\n**Organization:** (interview)\n")
    expect(hasLifeos()).toBe(true)
    const s = lifeosSources()
    expect(s.map((x) => x.label)).toEqual(["LifeOS identity"])
    expect(s[0]!.text).toContain("Acme")
  })
})
