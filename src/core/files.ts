import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { changed, tx } from './db'
import type { Db } from './db'
import { now, readDoc } from './docs'
import { DodoError } from './errors'
import { isInlineImage, MAX_FILE_BYTES, mimeFor } from './mime'
import type { FileMeta } from './types'

export { MAX_FILE_BYTES }

export function filesDir(): string {
  return process.env.DODO_FILES ?? path.join(os.homedir(), '.dodo', 'files')
}

// Display name only; the file on disk is always named by its uuid.
function cleanName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  return base.replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 255) || 'file'
}

const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/

const toMeta = (r: Record<string, unknown>): FileMeta => ({
  id: String(r.id),
  filename: String(r.filename),
  mime: String(r.mime),
  size: Number(r.size),
  created: String(r.created),
})

// Files of live docs, grouped by doc row id. Pass docId to load one doc's files.
export async function loadFiles(db: Db, docId?: number): Promise<Map<number, FileMeta[]>> {
  const rows = await db.unsafe<Record<string, unknown>[]>(
    `SELECT f.* FROM files f JOIN docs d ON d.id = f.doc_id WHERE d.deleted_at IS NULL ${docId === undefined ? '' : 'AND d.id = $1'} ORDER BY f.created, f.seq`,
    docId === undefined ? [] : [docId],
  )
  const out = new Map<number, FileMeta[]>()
  for (const r of rows) {
    const id = Number(r.doc_id)
    if (!out.has(id)) out.set(id, [])
    out.get(id)!.push(toMeta(r))
  }
  return out
}

async function docRowId(db: Db, docPath: string): Promise<number> {
  const p = (await readDoc(db, docPath)).path
  const [row] = await db<{ id: number }[]>`SELECT id FROM docs WHERE path = ${p} AND deleted_at IS NULL`
  return row.id
}

export async function addFile(
  db: Db,
  docPath: string,
  file: { filename: string; mime?: string; data: Uint8Array },
  dir = filesDir(),
): Promise<FileMeta> {
  const docId = await docRowId(db, docPath)
  if (file.data.byteLength > MAX_FILE_BYTES) throw new DodoError('invalid', 'file exceeds 25 MB')
  const filename = cleanName(file.filename)
  const mime = file.mime && MIME_RE.test(file.mime) ? file.mime.toLowerCase() : mimeFor(filename)
  const meta: FileMeta = { id: randomUUID(), filename, mime, size: file.data.byteLength, created: now() }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, meta.id), file.data, { flag: 'wx' })
  await tx(db, async (t) => {
    await t`INSERT INTO files (id, doc_id, filename, mime, size, created)
      VALUES (${meta.id}, ${docId}, ${meta.filename}, ${meta.mime}, ${meta.size}, ${meta.created})`
    await t`UPDATE docs SET updated = ${meta.created} WHERE id = ${docId}`
    await changed(t)
  })
  return meta
}

export async function getFile(db: Db, id: string, dir = filesDir()): Promise<FileMeta & { file: string }> {
  const [row] = await db<Record<string, unknown>[]>`SELECT f.* FROM files f JOIN docs d ON d.id = f.doc_id WHERE f.id = ${id} AND d.deleted_at IS NULL`
  if (!row) throw new DodoError('not_found', `file ${id} not found`)
  const meta = toMeta(row)
  return { ...meta, file: path.join(dir, meta.id) }
}

// Deletes the row only; the file stays on disk for the cleanup job. Touching the file restarts
// its 7-day clock, so backups taken before the removal can still be restored.
export async function removeFile(db: Db, id: string, dir = filesDir()): Promise<void> {
  await tx(db, async (t) => {
    const [row] = await t<{ doc_id: number }[]>`SELECT doc_id FROM files WHERE id = ${id}`
    if (!row) throw new DodoError('not_found', `file ${id} not found`)
    await t`DELETE FROM files WHERE id = ${id}`
    await t`UPDATE docs SET updated = ${now()} WHERE id = ${row.doc_id}`
    await changed(t)
  })
  const file = path.join(dir, id)
  if (fs.existsSync(file)) fs.utimesSync(file, new Date(), new Date())
}

export function fileMarkdown(meta: FileMeta): string {
  const name = meta.filename.replace(/[[\]]/g, '\\$&')
  return `${isInlineImage(meta.mime) ? '!' : ''}[${name}](/api/files/${meta.id})`
}
