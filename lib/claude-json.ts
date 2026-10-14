import type Anthropic from '@anthropic-ai/sdk'

// ONE STRUCTURED CLAUDE CALL — shared by the buying-intent judge, the closing
// coach and the competitor USP writer (cost pass, owner 2026-10-12).
//
//   • JSON out via output_config.format (json_schema), parsed here.
//   • Opus / Sonnet: server-side refusal fallback (`fallbacks: "default"`, beta
//     server-side-fallback-2026-07-01) — a policy decline is re-run on a model
//     the API picks, inside the same call. Haiku 5.5 has no server-side
//     fallback, so it's never sent there.
//   • Overloaded / 5xx / timeout → one more go on `fallbackModel`.
//   • `effort` is always explicit: defaults differ by model (Opus 5.5 and
//     Haiku 5.5 default to medium) and an unset effort silently changes cost.
//   • `cacheSystem` marks the system prompt for prompt caching (owner,
//     2026-10-15): calls that repeat it within 5 minutes pay 5% for it. Only
//     worth it when another call follows — a write nobody reads costs 25% more.
//
// `fallbacks` is newer than this SDK's types, so the request goes through the
// beta endpoint with a cast — the same pattern as agents/linkedin/prompt.ts.

export type ClaudeJsonResult<T> = { data: T | null; model: string; stop: string | null; usage: Anthropic.Beta.Messages.BetaUsage | null; refused: boolean }

const serverFallback = (model: string) => /^claude-(opus|sonnet)-/.test(model)

export type ClaudeJsonArgs = {
  model: string
  fallbackModel?: string
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  system: string
  cacheSystem?: boolean
  user: string
  schema: Record<string, unknown>
}

/** The request body claudeJson sends, without the server-side fallback — also what a Batch API request carries. */
export function jsonRequest(args: Omit<ClaudeJsonArgs, 'model' | 'fallbackModel'>, model: string) {
  return {
    model,
    max_tokens: args.maxTokens,
    output_config: { effort: args.effort, format: { type: 'json_schema', schema: args.schema } },
    system: args.cacheSystem ? [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }] : args.system,
    messages: [{ role: 'user', content: args.user }],
  }
}

/** The JSON a structured-output reply carries. Throws when it isn't JSON. */
export function jsonFrom<T>(res: { content: { type: string; text?: string }[]; stop_reason?: string | null }): T {
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`model returned non-JSON (stop_reason ${res.stop_reason})`)
  }
}

export async function claudeJson<T>(args: ClaudeJsonArgs & { anthropic: Anthropic }): Promise<ClaudeJsonResult<T>> {
  const call = async (model: string) => {
    const params = {
      ...jsonRequest(args, model),
      ...(serverFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
    }
    return args.anthropic.beta.messages.create(
      params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      { maxRetries: 4 },
    )
  }
  let model = args.model
  let res: Anthropic.Beta.Messages.BetaMessage
  try {
    res = await call(model)
  } catch (e) {
    if (!args.fallbackModel || !/overloaded|529|50\d|timeout/i.test((e as Error).message)) throw e
    model = args.fallbackModel
    res = await call(model)
  }
  if (res.stop_reason === 'refusal') return { data: null, model: res.model ?? model, stop: res.stop_reason, usage: res.usage ?? null, refused: true }
  const data = jsonFrom<T>(res as unknown as Parameters<typeof jsonFrom>[0])
  return { data, model: res.model ?? model, stop: res.stop_reason ?? null, usage: res.usage ?? null, refused: false }
}
