import Fuse from 'fuse.js'
import type { Db } from './db'
import { normalizeProject, titleOf } from './paths'
import type { DocIndex } from './types'

export type Hit = { path: string; title: string; snippet?: string }

// About `words` words around the first case-insensitive match of q, with … where the body is cut.
export function snippetOf(body: string, q: string, words = 12): string {
  const tokens = [...body.matchAll(/\S+/g)]
  const at = body.toLowerCase().indexOf(q.toLowerCase())
  const k = Math.max(0, tokens.findIndex((t) => t.index + t[0].length > at))
  const start = Math.max(0, Math.min(k - Math.floor(words / 2), tokens.length - words))
  const end = Math.min(tokens.length, start + words)
  return `${start > 0 ? '…' : ''}${tokens.slice(start, end).map((t) => t[0]).join(' ')}${end < tokens.length ? '…' : ''}`
}

// Fuzzy over paths and titles, then trigram-indexed substring search over bodies (3+ chars), deduped by path.
export async function searchDocs(db: Db, index: DocIndex, q: string, opts: { project?: string; limit?: number } = {}): Promise<Hit[]> {
  const query = q.trim()
  if (!query) return []
  const limit = opts.limit ?? 20
  const project = opts.project ? normalizeProject(opts.project) : undefined
  const docs = project ? index.docs.filter((d) => d.projects.includes(project)) : index.docs
  const hits: Hit[] = new Fuse(docs, { keys: ['path', 'title'], threshold: 0.4 })
    .search(query)
    .map(({ item }) => ({ path: item.path, title: item.title }))
  if (query.length >= 3) {
    const like = query.replace(/[\\%_]/g, '\\$&')
    const rows = await db.unsafe<{ path: string; body: string }[]>(
      `SELECT d.path, d.body FROM docs d
       WHERE d.deleted_at IS NULL AND d.body ILIKE '%' || $1 || '%' ESCAPE '\\'
       ${project ? 'AND EXISTS (SELECT 1 FROM doc_projects p WHERE p.doc_id = d.id AND p.project = $4)' : ''}
       ORDER BY word_similarity($2, d.body) DESC LIMIT $3`,
      [like, query, limit, ...(project ? [project] : [])],
    )
    const seen = new Set(hits.map((h) => h.path))
    for (const r of rows) if (!seen.has(r.path)) hits.push({ path: r.path, title: titleOf(r.path, r.body), snippet: snippetOf(r.body, query) })
  }
  return hits.slice(0, limit)
}
