import { connect, migrate } from '../core/db'

// Applies pending migrations to DATABASE_URL: `node dist/migrate.js`. Each deploy runs it before the new slot starts.
async function main() {
  const sql = connect()
  try {
    const { from, to } = await migrate(sql)
    console.log(`dodo: migration ${from} -> ${to}`)
  } finally {
    await sql.end()
  }
}
main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
