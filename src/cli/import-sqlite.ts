import { DatabaseSync } from 'node:sqlite'
import type postgres from 'postgres'
import { connect, MIGRATIONS, tx } from '../core/db'

const TABLES = {
  docs: ['id', 'path', 'body', 'created', 'updated', 'client_id', 'deleted_at', 'write_client_id'],
  doc_projects: ['doc_id', 'project'],
  files: ['id', 'doc_id', 'filename', 'mime', 'size', 'created', 'seq'],
} as const
type Count = { table: string; sqlite: number; postgres: number }

// One-time copy of dodo's old SQLite DB into an empty, migrated schema. Rolls back unless every count matches.
export async function importSqlite(file: string, db: postgres.Sql): Promise<Count[]> {
  const src = new DatabaseSync(file, { readOnly: true })
  try {
    return await tx(db, async (t) => {
      const [{ n }] = await t<{ n: number }[]>`SELECT count(*)::int AS n FROM docs`
      if (n > 0) throw new Error('docs is not empty; import only into a fresh schema')
      const counts: Count[] = []
      for (const [table, cols] of Object.entries(TABLES)) {
        const select = table === 'files' ? 'SELECT *, rowid AS seq FROM files ORDER BY rowid' : `SELECT * FROM ${table} ORDER BY rowid`
        const rows = (src.prepare(select).all() as Record<string, unknown>[]).map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null])))
        for (let i = 0; i < rows.length; i += 500) await t`INSERT INTO ${t(table)} ${t(rows.slice(i, i + 500) as Record<string, string>[], ...cols)}`
        const [{ n: got }] = await t<{ n: number }[]>`SELECT count(*)::int AS n FROM ${t(table)}`
        counts.push({ table, sqlite: rows.length, postgres: got })
      }
      await t`SELECT setval(pg_get_serial_sequence('docs', 'id'), (SELECT coalesce(max(id), 0) + 1 FROM docs), false)`
      await t`SELECT setval(pg_get_serial_sequence('files', 'seq'), (SELECT coalesce(max(seq), 0) + 1 FROM files), false)`
      await t`UPDATE schema_version SET v = ${MIGRATIONS.length}`
      if (counts.some((c) => c.sqlite !== c.postgres)) throw new Error(`row counts differ: ${JSON.stringify(counts)}`)
      return counts
    })
  } finally {
    src.close()
  }
}

// `node dist/import-sqlite.js /data/dodo.db`, once, after `node dist/migrate.js` and before the first deploy.
if (require.main === module) {
  const file = process.argv[2]
  const sql = connect()
  ;(file ? importSqlite(file, sql) : Promise.reject(new Error('usage: import-sqlite <sqlite file>')))
    .then((counts) => { for (const c of counts) console.log(`${c.table}: sqlite ${c.sqlite}, postgres ${c.postgres}`) })
    .catch((err) => { console.error(`error: ${err instanceof Error ? err.message : err}`); process.exitCode = 1 })
    .finally(() => sql.end())
}
