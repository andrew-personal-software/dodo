import { changed, tx } from './db'
import type { Db } from './db'
import { DodoError } from './errors'
import { hash } from './format'
import { loadFiles } from './files'
import { normalizePath, normalizeProject, titleOf } from './paths'
import type { Doc, DocIndex, FileMeta } from './types'

export type SaveResult = { doc: Doc; conflictOf?: string }
type Row = { id: number; path: string; body: string; created: string; updated: string; projects: string | null }

export const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

const SELECT = `SELECT d.id, d.path, d.body, d.created, d.updated,
  (SELECT string_agg(project, ',' ORDER BY project) FROM doc_projects WHERE doc_id = d.id) AS projects
  FROM docs d WHERE d.deleted_at IS NULL`

function toDoc(r: Row, files: FileMeta[] = []): Doc {
  return {
    path: r.path,
    title: titleOf(r.path, r.body),
    body: r.body,
    projects: r.projects ? r.projects.split(',') : [],
    created: r.created,
    updated: r.updated,
    bodyHash: hash(r.body),
    files,
  }
}

async function findRow(db: Db, path: string): Promise<Row | undefined> {
  const [row] = await db.unsafe<Row[]>(`${SELECT} AND d.path = $1`, [path])
  return row
}

export async function readDoc(db: Db, path: string): Promise<Doc> {
  const p = normalizePath(path)
  const row = await findRow(db, p)
  if (!row) throw new DodoError('not_found', `doc ${p} not found`)
  return toDoc(row, (await loadFiles(db, row.id)).get(row.id))
}

export async function loadIndex(db: Db): Promise<DocIndex> {
  const files = await loadFiles(db)
  return { docs: (await db.unsafe<Row[]>(`${SELECT} ORDER BY d.path COLLATE "C"`)).map((r) => toDoc(r, files.get(r.id))) }
}

function normalizeProjects(projects: string[]): string[] {
  return [...new Set(projects.map(normalizeProject))].sort()
}

async function insert(t: Db, path: string, body: string, projects: string[], clientId?: string): Promise<Doc> {
  const n = now()
  const [{ id }] = await t<{ id: number }[]>`
    INSERT INTO docs (path, body, created, updated, client_id) VALUES (${path}, ${body}, ${n}, ${n}, ${clientId ?? null}) RETURNING id`
  for (const p of projects) await t`INSERT INTO doc_projects (doc_id, project) VALUES (${id}, ${p})`
  await changed(t)
  return readDoc(t, path)
}

async function byClientId(t: Db, clientId: string | undefined, path: string): Promise<SaveResult | undefined> {
  if (!clientId) return
  const [row] = await t<{ path: string; deleted_at: string | null }[]>`SELECT path, deleted_at FROM docs WHERE client_id = ${clientId}`
  if (!row) return
  if (row.deleted_at) throw new DodoError('not_found', `doc ${row.path} not found`)
  const doc = await readDoc(t, row.path)
  return doc.path === path ? { doc } : { doc, conflictOf: path }
}

async function saveCopy(t: Db, path: string, body: string, projects: string[], clientId?: string): Promise<SaveResult> {
  let n = 1
  while (await findRow(t, `${path}.conflict-${n}`)) n++
  return { doc: await insert(t, `${path}.conflict-${n}`, body, projects, clientId), conflictOf: path }
}

export async function createDoc(
  db: Db,
  input: { path: string; body: string; projects?: string[]; clientId?: string; onConflict?: 'copy' },
): Promise<SaveResult> {
  const path = normalizePath(input.path)
  const projects = normalizeProjects(input.projects ?? [])
  return tx(db, async (t) => {
    const prior = await byClientId(t, input.clientId, path)
    if (prior) return prior
    if (!(await findRow(t, path))) return { doc: await insert(t, path, input.body, projects, input.clientId) }
    if (input.onConflict !== 'copy') throw new DodoError('conflict', `doc ${path} already exists`)
    return saveCopy(t, path, input.body, projects, input.clientId)
  })
}

export async function writeDoc(
  db: Db,
  path: string,
  input: { body: string; baseHash: string; clientId?: string; onConflict?: 'copy' },
): Promise<SaveResult> {
  const p = normalizePath(path)
  return tx(db, async (t) => {
    const current = await readDoc(t, p)
    if (current.bodyHash === hash(input.body)) return { doc: current }
    const [last] = await t<{ id: string | null }[]>`SELECT write_client_id AS id FROM docs WHERE path = ${p} AND deleted_at IS NULL`
    // A retry of a write that landed (its response lost) may carry a newer body; it is not a conflict.
    if (input.baseHash === current.bodyHash || (input.clientId && last.id === input.clientId)) {
      await t`UPDATE docs SET body = ${input.body}, updated = ${now()}, write_client_id = ${input.clientId ?? null}
        WHERE path = ${p} AND deleted_at IS NULL`
      await changed(t)
      return { doc: await readDoc(t, p) }
    }
    if (input.onConflict !== 'copy') throw new DodoError('conflict', `doc ${p} changed since it was read`)
    return (await byClientId(t, input.clientId, p)) ?? saveCopy(t, p, input.body, current.projects, input.clientId)
  })
}

export async function movePath(db: Db, from: string, to: string): Promise<string[]> {
  const src = normalizePath(from)
  const dst = normalizePath(to)
  if (dst === src || dst.startsWith(src + '/')) throw new DodoError('usage', `cannot move ${src} into itself`)
  return tx(db, async (t) => {
    const rows = await t<{ id: number; path: string }[]>`SELECT id, path FROM docs WHERE deleted_at IS NULL`
    const moving = rows.filter((r) => r.path === src || r.path.startsWith(src + '/'))
    if (!moving.length) throw new DodoError('not_found', `nothing at ${src}`)
    const targets = moving.map((r) => ({ id: r.id, path: normalizePath(dst + r.path.slice(src.length)) }))
    const staying = new Set(rows.filter((r) => !moving.includes(r)).map((r) => r.path))
    const taken = targets.find((x) => staying.has(x.path))
    if (taken) throw new DodoError('conflict', `doc ${taken.path} already exists`)
    const n = now()
    // Two passes so a target that is also a source path never trips the unique index mid-move.
    // The temp prefix is \x01: Postgres text cannot hold \0.
    for (const m of targets) await t`UPDATE docs SET path = ${`\x01${m.id}`}, updated = ${n} WHERE id = ${m.id}`
    for (const m of targets) await t`UPDATE docs SET path = ${m.path}, updated = ${n} WHERE id = ${m.id}`
    await changed(t)
    return targets.map((m) => m.path)
  })
}

export async function deleteDoc(db: Db, path: string): Promise<void> {
  const p = normalizePath(path)
  await tx(db, async (t) => {
    await readDoc(t, p)
    await t`UPDATE docs SET deleted_at = ${now()} WHERE path = ${p} AND deleted_at IS NULL`
    await changed(t)
  })
}

export async function setProjects(db: Db, path: string, projects: string[]): Promise<Doc> {
  const p = normalizePath(path)
  const keys = normalizeProjects(projects)
  return tx(db, async (t) => {
    const id = (await findRow(t, p))?.id
    if (id === undefined) throw new DodoError('not_found', `doc ${p} not found`)
    await t`DELETE FROM doc_projects WHERE doc_id = ${id}`
    for (const k of keys) await t`INSERT INTO doc_projects (doc_id, project) VALUES (${id}, ${k})`
    await t`UPDATE docs SET updated = ${now()} WHERE id = ${id}`
    await changed(t)
    return readDoc(t, p)
  })
}
