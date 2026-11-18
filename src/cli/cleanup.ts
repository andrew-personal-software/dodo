import fs from 'node:fs'
import path from 'node:path'
import { connect } from '../core/db'
import type { Db } from '../core/db'
import { filesDir } from '../core/files'

const WEEK = 7 * 24 * 3600 * 1000

// Deletes upload files with no files row whose mtime is over 7 days old. hawk backs up the DB.
export async function cleanup(db: Db, dir = filesDir()): Promise<number> {
  if (!fs.existsSync(dir)) return 0
  const ids = new Set((await db<{ id: string }[]>`SELECT id FROM files`).map((r) => r.id))
  const cutoff = Date.now() - WEEK
  const orphans = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !ids.has(e.name))
    .map((e) => path.join(dir, e.name))
    .filter((f) => fs.statSync(f).mtimeMs < cutoff)
  for (const f of orphans) fs.rmSync(f)
  return orphans.length
}

// `node dist/cleanup.js`: run nightly by hawk as the dodo-cleanup job.
if (require.main === module) {
  const sql = connect()
  cleanup(sql)
    .then((n) => console.log(`removed ${n} orphan files from ${filesDir()}`))
    .catch((err) => { console.error(`error: ${err instanceof Error ? err.message : err}`); process.exitCode = 1 })
    .finally(() => sql.end())
}
