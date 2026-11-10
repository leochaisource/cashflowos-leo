import { createHash, timingSafeEqual } from 'crypto'
import { supabase, supabaseConfigured } from '@/lib/supabase'
import { TOOLS, callTool } from '@/lib/mcp-progress'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// THE "SPEAKFUNNELS DASHBOARD" CONNECTOR (owner, 2026-11-10) — a remote MCP server
// that claude.ai and Cowork call (Customize › Connectors › Add custom connector,
// "No sign-in"). Calls come from Anthropic's cloud, which can't log in, so the
// only gate is the unguessable key in the path: MCP_CONNECTOR_KEY, compared as
// sha256 hashes in constant time; a wrong key is a plain 404 and the URL is
// never logged. The tools are in lib/mcp-progress.ts.
//
// Stateless Streamable HTTP, JSON responses only:
//   initialize → echoes a version we speak, else 2025-11-25 · notifications → 202
//   ping → {} · tools/list · tools/call · unknown → -32601 · GET → 405
//   server/discover → 400 empty (a 2026-07-28 client then falls back to initialize)
//   ?dry=1 → tools/call writes nothing (not in production)

const VERSIONS = ['2025-03-26', '2025-06-18', '2025-11-25']
const LATEST = '2025-11-25'
const MAX_BODY = 64_000

const INSTRUCTIONS =
  "Leo Chai's client progress tracker (SpeakFunnels Command Centre). When a chat finishes work that moves one of " +
  "his clients forward, or he says \"log this\", call log_progress with what got done and the next to-dos. Use " +
  'list_clients for the exact client names and list_todos before complete_todo. Clients only: not his own brand, ' +
  'LinkedIn or job hunt.'

function keyOk(given: string | undefined): boolean {
  const want = process.env.MCP_CONNECTOR_KEY?.trim()
  if (!want || !given) return false
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(want).digest()
  return timingSafeEqual(a, b)
}

const notFound = () => new Response('Not found', { status: 404 })
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const result = (id: unknown, r: unknown) => json({ jsonrpc: '2.0', id, result: r })
const failure = (id: unknown, code: number, message: string, status = 200) => json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, status)

type Ctx = { params: Promise<{ key: string }> }

export async function GET(_req: Request, { params }: Ctx) {
  if (!keyOk((await params).key)) return notFound()
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!keyOk((await params).key)) return notFound()
  return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } })
}

export async function POST(req: Request, { params }: Ctx) {
  if (!keyOk((await params).key)) return notFound()
  const raw = await req.text()
  if (raw.length > MAX_BODY) return failure(null, -32600, 'Request too large', 413)
  let msg: { id?: unknown; method?: string; params?: Record<string, any> }
  try {
    msg = JSON.parse(raw)
  } catch {
    return failure(null, -32700, 'Parse error', 400)
  }
  if (Array.isArray(msg) || !msg || typeof msg !== 'object') return failure(null, -32600, 'One JSON-RPC request per call', 400)
  const { id, method, params: p } = msg
  if (method === 'server/discover') return new Response(null, { status: 400 })
  // A notification (no id) needs no answer.
  if (id === undefined || id === null) return new Response(null, { status: 202 })

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: VERSIONS.includes(p?.protocolVersion) ? p!.protocolVersion : LATEST,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'speakfunnels-dashboard', title: 'SpeakFunnels dashboard', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      })
    case 'ping':
      return result(id, {})
    case 'tools/list':
      return result(id, { tools: TOOLS })
    case 'tools/call': {
      if (!supabaseConfigured) return result(id, { content: [{ type: 'text', text: 'The dashboard database is not connected.' }], isError: true })
      const name = String(p?.name ?? '')
      const args = p?.arguments && typeof p.arguments === 'object' ? (p.arguments as Record<string, any>) : {}
      const dry = new URL(req.url).searchParams.get('dry') === '1' && process.env.VERCEL_ENV !== 'production'
      try {
        const out = await callTool(supabase, name, args, { dry })
        return result(id, { content: [{ type: 'text', text: out.text }], isError: !!out.isError })
      } catch (e) {
        console.error('[CFO] mcp tool failed:', name, (e as Error).message)
        return result(id, { content: [{ type: 'text', text: 'The dashboard could not do that just now. Try again in a minute.' }], isError: true })
      }
    }
    default:
      return failure(id, -32601, 'Method not found')
  }
}
