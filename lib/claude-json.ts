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
//
// `fallbacks` is newer than this SDK's types, so the request goes through the
// beta endpoint with a cast — the same pattern as agents/linkedin/prompt.ts.

export type ClaudeJsonResult<T> = { data: T | null; model: string; stop: string | null; usage: Anthropic.Beta.Messages.BetaUsage | null; refused: boolean }

const serverFallback = (model: string) => /^claude-(opus|sonnet)-/.test(model)

export async function claudeJson<T>(args: {
  anthropic: Anthropic
  model: string
  fallbackModel?: string
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  system: string
  user: string
  schema: Record<string, unknown>
}): Promise<ClaudeJsonResult<T>> {
  const call = async (model: string) => {
    const params = {
      model,
      max_tokens: args.maxTokens,
      ...(serverFallback(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      output_config: { effort: args.effort, format: { type: 'json_schema', schema: args.schema } },
      system: args.system,
      messages: [{ role: 'user', content: args.user }],
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
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
  let data: T | null = null
  try {
    data = JSON.parse(text) as T
  } catch {
    throw new Error(`model returned non-JSON (stop_reason ${res.stop_reason})`)
  }
  return { data, model: res.model ?? model, stop: res.stop_reason ?? null, usage: res.usage ?? null, refused: false }
}
