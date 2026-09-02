// The only place jobsweep talks to a model. Off unless the user configured one:
// JOBSWEEP_MODEL (or profile `model`) = "openai:<model>" | "anthropic:<model>", with the
// matching key in the environment. `search`/`digest` never import this; only
// `interview`, `rank`, and `digest --rank` do.

export interface Message {
  role: "user" | "assistant"
  content: string
}

export interface CompleteRequest {
  system: string
  messages: Message[]
  /** Ask the provider for a JSON object response where supported. */
  json?: boolean
  maxTokens?: number
}

export interface Model {
  /** Provider-qualified name, e.g. "openai:gpt-4o-mini". */
  name: string
  complete(req: CompleteRequest): Promise<string>
}

export class ModelError extends Error {}

export const MODEL_HELP =
  "No model configured. Set JOBSWEEP_MODEL (or \"model\" in profile.json) to e.g. openai:gpt-4o-mini or anthropic:claude-3-5-haiku-latest, " +
  "and put OPENAI_API_KEY (optionally OPENAI_BASE_URL for OpenRouter/Ollama/LM Studio) or ANTHROPIC_API_KEY in ~/.config/jobsweep/.env."

const TIMEOUT_MS = 90_000

function openai(model: string): Model {
  const key = process.env.OPENAI_API_KEY
  const base = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "")
  // Local OpenAI-compatible servers (Ollama, LM Studio) accept any key; a hosted API needs a real one.
  if (!key && /api\.openai\.com|openrouter\.ai/.test(base)) throw new ModelError(`OPENAI_API_KEY is not set (model ${model}). ${MODEL_HELP}`)
  return {
    name: `openai:${model}`,
    async complete(req) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key ?? "none"}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "system", content: req.system }, ...req.messages],
          max_tokens: req.maxTokens ?? 2048,
          temperature: 0.2,
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new ModelError(`${base} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`)
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const text = body.choices?.[0]?.message?.content
      if (typeof text !== "string") throw new ModelError("model returned no text")
      return text
    },
  }
}

function anthropic(model: string): Model {
  const key = process.env.ANTHROPIC_API_KEY
  const base = (process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/+$/, "")
  if (!key) throw new ModelError(`ANTHROPIC_API_KEY is not set (model ${model}). ${MODEL_HELP}`)
  return {
    name: `anthropic:${model}`,
    async complete(req) {
      const res = await fetch(`${base}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          system: req.system + (req.json ? "\nRespond with a single JSON object and nothing else." : ""),
          messages: req.messages,
          max_tokens: req.maxTokens ?? 2048,
          temperature: 0.2,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!res.ok) throw new ModelError(`${base} → ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`)
      const body = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
      const text = body.content?.find((c) => c.type === "text")?.text
      if (typeof text !== "string") throw new ModelError("model returned no text")
      return text
    },
  }
}

/** Resolve a model from a spec like "openai:gpt-4o-mini". Null when nothing is configured; throws when configured but unusable. */
export function configureModel(spec: string | null | undefined): Model | null {
  const s = (spec ?? process.env.JOBSWEEP_MODEL ?? "").trim()
  if (!s) return null
  const [provider, ...rest] = s.split(":")
  const model = rest.join(":")
  if (!model) throw new ModelError(`model spec "${s}" must be provider:model. ${MODEL_HELP}`)
  if (provider === "openai") return openai(model)
  if (provider === "anthropic") return anthropic(model)
  throw new ModelError(`unknown provider "${provider}" in "${s}" — use openai:<model> or anthropic:<model>`)
}

/** Pull the first JSON object/array out of a response that may carry fences or prose. */
export function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.search(/[[{]/)
  if (start === -1) throw new ModelError(`no JSON in model response: ${text.slice(0, 120)}`)
  return body.slice(start).trim()
}

/** Ask for JSON, parse it, and retry once with the parse error if the model got it wrong. */
export async function completeJson<T>(model: Model, req: CompleteRequest, validate?: (v: unknown) => v is T): Promise<T> {
  let messages = req.messages
  for (let attempt = 0; ; attempt++) {
    const text = await model.complete({ ...req, messages, json: true })
    try {
      const parsed = JSON.parse(extractJson(text)) as unknown
      if (validate && !validate(parsed)) throw new ModelError("response did not match the expected shape")
      return parsed as T
    } catch (e) {
      if (attempt >= 1) throw e instanceof ModelError ? e : new ModelError(`could not parse model JSON: ${e instanceof Error ? e.message : e}`)
      messages = [...messages, { role: "assistant", content: text }, { role: "user", content: `That was not valid JSON of the requested shape (${e instanceof Error ? e.message : e}). Reply again with only the JSON.` }]
    }
  }
}
