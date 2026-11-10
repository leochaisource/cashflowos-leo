import type { SupabaseClient } from '@supabase/supabase-js'
import { matchProject } from './ad-clients.ts'
import { klToday } from './format.ts'
import { addTodos, allTasks, cleanLine, completeTodo, isOpen, loadClients, logProgress, textKey, validDue, type ProgressClient } from './progress.ts'

// THE "SPEAKFUNNELS DASHBOARD" CONNECTOR'S TOOLS (owner, 2026-11-10) — what a
// claude.ai or Cowork chat can do through app/api/mcp/[key]. Chats have no
// readable history, so they push: when a chat moves a client's work forward, it
// logs what got done and the next to-dos here.
//
// Deliberately small: no model calls (a leaked URL can't cost money), only
// client projects, only open to-dos, short inputs, ~60 writes a day, and every
// to-do a chat adds is listed in the next 9am Today message. Whatever a chat
// sends is data — it's stored as text, never acted on.

export const MCP_DAILY_WRITES = 60
const MAX_LINES = 5
const MAX_TODOS = 5

export const TOOLS = [
  {
    name: 'list_clients',
    title: 'List clients',
    description: "Leo's clients on the SpeakFunnels dashboard, with how many open to-dos each has. Use it to get a client's exact name.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'list_todos',
    title: 'List open to-dos',
    description: "Leo's open to-dos (next steps) for one client, or for all clients. Each has an id for complete_todo.",
    inputSchema: {
      type: 'object',
      properties: { client: { type: 'string', description: 'Client name, e.g. "Starcity" or "Nicsman". Leave out for all.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'log_progress',
    title: 'Log progress for a client',
    description:
      "Record what got DONE for one of Leo's clients in this chat, and any NEXT to-dos it left. Call it when a chat " +
      'finishes work that moves a client forward, or when Leo says "log this". Done lines: short, plain, past tense, ' +
      'outcomes not process ("Wrote the 6 Nov webinar reminder sequence"). To-dos: start with a verb, ' +
      'due as YYYY-MM-DD only if a date was set. Not for Leo\'s own brand, LinkedIn or job hunt.',
    inputSchema: {
      type: 'object',
      properties: {
        client: { type: 'string', description: 'The client the work was for (see list_clients).' },
        done: { type: 'array', items: { type: 'string' }, maxItems: MAX_LINES, description: 'What got done, up to 5 short lines.' },
        todos: {
          type: 'array',
          maxItems: MAX_TODOS,
          items: {
            type: 'object',
            properties: { title: { type: 'string' }, due: { type: 'string', description: 'YYYY-MM-DD, optional' } },
            required: ['title'],
            additionalProperties: false,
          },
          description: 'Next actions for Leo or his team, up to 5.',
        },
      },
      required: ['client', 'done'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'add_todo',
    title: 'Add a to-do',
    description: "Add one to-do (next step) to a client's list on the dashboard.",
    inputSchema: {
      type: 'object',
      properties: {
        client: { type: 'string' },
        title: { type: 'string', description: 'Starts with a verb, under 140 characters.' },
        due: { type: 'string', description: 'YYYY-MM-DD, optional' },
      },
      required: ['client', 'title'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'complete_todo',
    title: 'Tick off a to-do',
    description: 'Mark one open to-do done, by its id from list_todos. Only when Leo says it is done or the chat just finished it.',
    inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const

export type ToolOut = { text: string; isError?: boolean }

function resolve(clients: ProgressClient[], name: unknown): ProgressClient | string {
  const m = matchProject(cleanLine(String(name ?? ''), 80), clients)
  if (m.project) return m.project
  const names = (m.candidates.length && m.candidates.length < clients.length ? m.candidates : clients).map((c) => c.name)
  return `Which client? It must be one of: ${names.join(', ')}.`
}

/** Writes a chat made today, against the daily cap. */
async function writesToday(db: SupabaseClient): Promise<number> {
  const start = new Date(`${klToday()}T00:00:00+08:00`).toISOString()
  const [{ count: lines }, { count: todos }] = await Promise.all([
    db.from('progress_log').select('id', { count: 'exact', head: true }).eq('source', 'chat').gte('created_at', start),
    db.from('records').select('id', { count: 'exact', head: true }).eq('category', 'task').eq('meta->>from', 'chat').gte('created_at', start),
  ])
  return (lines ?? 0) + (todos ?? 0)
}

export async function callTool(db: SupabaseClient, name: string, args: Record<string, any>, opts: { dry?: boolean } = {}): Promise<ToolOut> {
  const dry = !!opts.dry
  const clients = await loadClients(db)

  if (name === 'list_clients') {
    const open = (await allTasks(db)).filter(isOpen)
    return {
      text: clients
        .map((c) => `${c.name} (${c.id}): ${open.filter((t) => t.meta?.project === c.id).length} open to-dos`)
        .join('\n'),
    }
  }

  if (name === 'list_todos') {
    const one = args.client ? resolve(clients, args.client) : null
    if (typeof one === 'string') return { text: one, isError: true }
    const names = new Map(clients.map((c) => [c.id, c.name]))
    const open = (await allTasks(db)).filter((t) => isOpen(t) && names.has(t.meta?.project) && (!one || t.meta.project === one.id))
    if (!open.length) return { text: one ? `No open to-dos for ${one.name}.` : 'No open client to-dos.' }
    return {
      text: open
        .sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'))
        .map((t) => `[${t.id}] ${t.title}${t.due_date ? ` (due ${t.due_date})` : ''} — ${names.get(t.meta.project)}`)
        .join('\n'),
    }
  }

  if (!['log_progress', 'add_todo', 'complete_todo'].includes(name)) return { text: `Unknown tool: ${cleanLine(name, 40)}`, isError: true }
  if (!dry && (await writesToday(db)) >= MCP_DAILY_WRITES)
    return { text: `Today's limit of ${MCP_DAILY_WRITES} dashboard writes from chats is used up. Text the Telegram bot instead.`, isError: true }

  if (name === 'complete_todo') {
    const id = Number(args.id)
    if (!Number.isInteger(id)) return { text: 'Give the to-do id from list_todos.', isError: true }
    const done = await completeTodo(db, id, { by: 'chat', clientIds: clients.map((c) => c.id), dry })
    return done ? { text: `Ticked off: ${done.title}` } : { text: `No open client to-do with id ${id}. Use list_todos.`, isError: true }
  }

  const client = resolve(clients, args.client)
  if (typeof client === 'string') return { text: client, isError: true }

  if (name === 'add_todo') {
    const title = cleanLine(String(args.title ?? ''), 140)
    if (!title) return { text: 'What is the to-do?', isError: true }
    const added = await addTodos(db, client.id, [{ title, due: validDue(args.due) }], { from: 'chat', dry })
    return { text: added.length ? `Added to ${client.name}: ${added[0]}` : `${client.name} already has that to-do (or its list of chat and Claude to-dos is full).` }
  }

  // log_progress
  const done = (Array.isArray(args.done) ? args.done : [])
    .slice(0, MAX_LINES)
    .map((d: unknown) => cleanLine(String(d ?? ''), 200))
    .filter((d: string) => textKey(d))
  const todos = (Array.isArray(args.todos) ? args.todos : [])
    .slice(0, MAX_TODOS)
    .map((t: any) => ({ title: cleanLine(String(t?.title ?? ''), 140), due: validDue(t?.due) }))
    .filter((t: { title: string }) => t.title)
  if (!done.length && !todos.length) return { text: 'Nothing to log: give at least one done line or to-do.', isError: true }
  const logged = await logProgress(db, done.map((text: string) => ({ project: client.id, text, source: 'chat' as const, sourceRef: 'chat' })), { dry })
  const added = todos.length ? await addTodos(db, client.id, todos, { from: 'chat', dry }) : []
  const parts = [`${dry ? '[dry run] ' : ''}Logged ${logged} done line${logged === 1 ? '' : 's'} for ${client.name}`]
  if (todos.length) parts.push(`added ${added.length} of ${todos.length} to-do${todos.length === 1 ? '' : 's'}${added.length < todos.length ? ' (the rest were already there)' : ''}`)
  return { text: `${parts.join(', ')}. It shows on the dashboard and in tomorrow's 9am Today message.` }
}
