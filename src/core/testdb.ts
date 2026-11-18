import { randomBytes } from 'node:crypto'
import { connect, dbUrl, migrate } from './db'

// A fresh schema test_<random> on the dev Postgres (TEST_DATABASE_URL in CI), migrated unless told not to.
export async function testDb(o: { migrate?: boolean } = {}) {
  const url = process.env.TEST_DATABASE_URL ?? dbUrl()
  const schema = `test_${randomBytes(6).toString('hex')}`
  const admin = connect(url, 'public')
  await admin.begin(async (t) => {
    await t`SELECT pg_advisory_xact_lock(hashtext('dodo-test-setup'))`
    await t`CREATE EXTENSION IF NOT EXISTS pg_trgm`
    await t.unsafe(`CREATE SCHEMA ${schema}`)
  })
  const db = connect(url, schema)
  if (o.migrate !== false) await migrate(db)
  return {
    db,
    url,
    schema,
    async drop() {
      await db.end()
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`)
      await admin.end()
    },
  }
}
