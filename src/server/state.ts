import type postgres from 'postgres'
import { CHANNEL, connect, hash, loadIndex } from '@/core'
import { DodoError } from '@/core'
import type { DocIndex, ErrorCode } from '@/core'

export type State = { db: postgres.Sql; index: DocIndex; rev: string }

declare global {
  // eslint-disable-next-line no-var
  var __dodo: State | Promise<State> | undefined
}

const loads = new WeakMap<State, Promise<void>>()

// Loads run one at a time, so an older load never overwrites a newer index.
export function refresh(state: State): Promise<void> {
  const next = (loads.get(state) ?? Promise.resolve()).catch(() => {}).then(async () => {
    state.index = await loadIndex(state.db)
    state.rev = hash(JSON.stringify(state.index))
  })
  loads.set(state, next)
  return next
}

// Loads the index, then reloads it on every dodo_changed NOTIFY: writes from the other deploy slot,
// and after a reconnect (onlisten), anything missed while the connection was down.
export async function startState(db: postgres.Sql): Promise<State> {
  const state: State = { db, index: { docs: [] }, rev: '' }
  await refresh(state)
  const reload = () => void refresh(state).catch((err) => console.error(`dodo: reload failed: ${err instanceof Error ? err.message : err}`))
  await db.listen(CHANNEL, reload, reload)
  return state
}

export function getState(): Promise<State> {
  globalThis.__dodo ??= startState(connect()).catch((err) => {
    globalThis.__dodo = undefined
    throw err
  })
  return Promise.resolve(globalThis.__dodo)
}

const STATUS: Record<ErrorCode, number> = { usage: 400, not_found: 404, conflict: 409, invalid: 422, version: 426, unavailable: 503 }

export function errorResponse(err: unknown): Response {
  if (err instanceof DodoError) {
    return Response.json({ error: { code: err.code, message: err.message } }, { status: STATUS[err.code] })
  }
  const message = err instanceof Error ? err.message : String(err)
  return Response.json({ error: { code: 'internal', message } }, { status: 500 })
}

export function pathParam(req: Request): string {
  const p = new URL(req.url).searchParams.get('path')
  if (!p) throw new DodoError('usage', 'missing ?path=')
  return p
}

type Shape = Record<string, 'string' | 'string?' | 'string[]?'>

// Reads a JSON object body and checks its field types, so bad input is a 400, not a 500.
export async function jsonBody<T>(req: Request, shape: Shape): Promise<T> {
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DodoError('usage', 'expected a JSON object body')
  for (const [key, type] of Object.entries(shape)) {
    const v = (body as Record<string, unknown>)[key]
    if (v === undefined && type.endsWith('?')) continue
    const ok = type.startsWith('string[]') ? Array.isArray(v) && v.every((x) => typeof x === 'string') : typeof v === 'string'
    if (!ok) throw new DodoError('usage', `"${key}" must be a ${type.replace('?', '')}`)
  }
  return body as T
}
