import { afterEach, beforeEach, expect, test } from 'vitest'
import { MIGRATIONS, migrate } from './db'
import { testDb } from './testdb'

let t: Awaited<ReturnType<typeof testDb>>
beforeEach(async () => { t = await testDb({ migrate: false }) })
afterEach(async () => { await t.drop() })

test('migrate a fresh schema, then again is a no-op', async () => {
  expect(await migrate(t.db)).toEqual({ from: 0, to: MIGRATIONS.length })
  const again = await migrate(t.db)
  expect(again.from).toBe(again.to)
})
test('a schema from a newer build is refused', async () => {
  await migrate(t.db)
  await t.db`UPDATE schema_version SET v = ${MIGRATIONS.length + 1}`
  await expect(migrate(t.db)).rejects.toThrow(/this build only knows/)
})
test('two migrates at once both succeed', async () => {
  const [a, b] = await Promise.all([migrate(t.db), migrate(t.db)])
  expect([a.to, b.to]).toEqual([MIGRATIONS.length, MIGRATIONS.length])
})
