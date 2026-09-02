// Where the interview learns about the candidate before asking anything.
// Every source is shown to the user and confirmed before it is used.
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, extname, join } from "node:path"
import { extractText, getDocumentProxy } from "unpdf"

export interface ContextSource {
  /** Short label shown to the user, e.g. "resume", "LifeOS identity". */
  label: string
  path: string
  text: string
}

/** Per-document cap on what is extracted and sent to a model; the consent line quotes this number. */
export const MAX_CHARS = 20_000

async function readDocument(path: string): Promise<string> {
  if (extname(path).toLowerCase() === ".pdf") {
    const pdf = await getDocumentProxy(new Uint8Array(readFileSync(path)))
    const { text } = await extractText(pdf, { mergePages: true })
    return text
  }
  return readFileSync(path, "utf8")
}

/** A resume or notes file the user pointed at: .pdf, .md, .txt (anything else is read as text). */
export async function fileSource(path: string, label = "resume"): Promise<ContextSource> {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`file not found: ${path}`)
  const text = (await readDocument(path)).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").trim()
  if (!text) throw new Error(`no text could be read from ${path}${extname(path).toLowerCase() === ".pdf" ? " (scanned PDF? export it as text)" : ""}`)
  return { label: `${label} (${basename(path)})`, path, text: text.slice(0, MAX_CHARS) }
}

/** Files a LifeOS install keeps about its principal, when present. Generic: any LifeOS user gets the same set. */
const LIFEOS_FILES: Array<[string, string]> = [
  ["LifeOS identity", "LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md"],
  ["LifeOS resume", "LIFEOS/USER/PRINCIPAL/RESUME.md"],
  ["LifeOS goals (TELOS)", "LIFEOS/USER/TELOS/TELOS.md"],
  ["LifeOS projects", "LIFEOS/USER/PROJECTS.md"],
]

export function lifeosDir(): string {
  return process.env.LIFEOS_DIR ?? join(homedir(), ".claude")
}

/** Skip template stubs that were never filled in — they'd only mislead the model. */
function isStub(text: string): boolean {
  return /\(interview\)/.test(text) && text.length < 1_500
}

export function lifeosSources(): ContextSource[] {
  const root = lifeosDir()
  const out: ContextSource[] = []
  for (const [label, rel] of LIFEOS_FILES) {
    const path = join(root, rel)
    if (!existsSync(path)) continue
    const text = readFileSync(path, "utf8").trim()
    if (!text || isStub(text)) continue
    out.push({ label, path, text: text.slice(0, MAX_CHARS) })
  }
  return out
}

export function hasLifeos(): boolean {
  return existsSync(join(lifeosDir(), "LIFEOS"))
}
