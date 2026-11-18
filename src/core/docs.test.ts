import { afterEach, beforeEach, expect, test } from 'vitest'
import { CHANNEL, connect } from './db'
import type { Db } from './db'
import { createDoc, deleteDoc, loadIndex, movePath, readDoc, writeDoc } from './docs'
import { testDb } from './testdb'

let t: Awaited<ReturnType<typeof testDb>>
let db: Db
beforeEach(async () => { t = await testDb(); db = t.db })
afterEach(async () => { await t.drop() })

const paths = async () => (await loadIndex(db)).docs.map((d) => d.path)

test('write with a stale hash conflicts; copy mode saves a copy once', async () => {
  const { doc } = await createDoc(db, { path: 'a', body: 'one' })
  await writeDoc(db, 'a', { body: 'two', baseHash: doc.bodyHash })
  await expect(writeDoc(db, 'a', { body: 'three', baseHash: doc.bodyHash })).rejects.toThrow(/conflict|changed/)
  const r1 = await writeDoc(db, 'a', { body: 'three', baseHash: doc.bodyHash, clientId: 'c1', onConflict: 'copy' })
  const r2 = await writeDoc(db, 'a', { body: 'three', baseHash: doc.bodyHash, clientId: 'c1', onConflict: 'copy' })
  expect(r1).toMatchObject({ conflictOf: 'a', doc: { path: 'a.conflict-1', body: 'three' } })
  expect(r2.doc.path).toBe('a.conflict-1')
  expect((await readDoc(db, 'a')).body).toBe('two')
})
test('retried write after it landed is a no-op success', async () => {
  const { doc } = await createDoc(db, { path: 'a', body: 'one' })
  await writeDoc(db, 'a', { body: 'two', baseHash: doc.bodyHash })
  const r = await writeDoc(db, 'a', { body: 'two', baseHash: doc.bodyHash, onConflict: 'copy' })
  expect(r.conflictOf).toBeUndefined()
  expect(await paths()).toEqual(['a'])
})
test('create is idempotent by clientId and conflicts on a taken path', async () => {
  await createDoc(db, { path: 'a', body: 'x', clientId: 'k' })
  expect((await createDoc(db, { path: 'a', body: 'x', clientId: 'k' })).doc.path).toBe('a')
  await expect(createDoc(db, { path: 'a', body: 'y' })).rejects.toThrow()
  expect((await createDoc(db, { path: 'a', body: 'y', onConflict: 'copy' })).doc.path).toBe('a.conflict-1')
})
test('movePath moves a folder and refuses to overwrite', async () => {
  await createDoc(db, { path: 'x/one', body: '' }); await createDoc(db, { path: 'x/two', body: '' }); await createDoc(db, { path: 'y/one', body: '' })
  await expect(movePath(db, 'x', 'y')).rejects.toThrow()
  expect(await paths()).toEqual(['x/one', 'x/two', 'y/one'])
  expect((await movePath(db, 'x', 'z')).sort()).toEqual(['z/one', 'z/two'])
})
test('movePath swaps into a path that is also a source', async () => {
  await createDoc(db, { path: 'x', body: '' }); await createDoc(db, { path: 'x/x', body: '' })
  expect((await movePath(db, 'x', 'z')).sort()).toEqual(['z', 'z/x'])
})
test('a deleted path can be reused; projects are normalized', async () => {
  await createDoc(db, { path: 'a', body: '' }); await deleteDoc(db, 'a')
  expect((await createDoc(db, { path: 'a', body: '', projects: ['spar', 'crow'] })).doc.projects).toEqual(['CROW', 'SPAR'])
})
test('retried write with a newer body after a lost response is not a conflict', async () => {
  const { doc } = await createDoc(db, { path: 'a', body: 'one' })
  await writeDoc(db, 'a', { body: 'two', baseHash: doc.bodyHash, clientId: 'w', onConflict: 'copy' })
  const r = await writeDoc(db, 'a', { body: 'three', baseHash: doc.bodyHash, clientId: 'w', onConflict: 'copy' })
  expect(r.conflictOf).toBeUndefined()
  expect((await loadIndex(db)).docs.map((d) => [d.path, d.body])).toEqual([['a', 'three']])
})
test('a write sends one notify on dodo_changed', async () => {
  const other = connect(t.url, t.schema)
  const got: string[] = []
  const l = await other.listen(CHANNEL, (p) => got.push(p))
  await createDoc(db, { path: 'a', body: '' })
  await expect.poll(() => got.length, { timeout: 2000 }).toBe(1)
  await l.unlisten()
  await other.end()
})
test('two writes with the same base from two slots: one wins, the other conflicts', async () => {
  const other = connect(t.url, t.schema)
  for (let i = 0; i < 20; i++) {
    const { doc } = await createDoc(db, { path: `a${i}`, body: 'one' })
    const r = await Promise.allSettled([
      writeDoc(db, `a${i}`, { body: 'from blue', baseHash: doc.bodyHash }),
      writeDoc(other, `a${i}`, { body: 'from green', baseHash: doc.bodyHash }),
    ])
    expect(r.map((x) => x.status).sort()).toEqual(['fulfilled', 'rejected'])
  }
  await other.end()
})
test('two creates of one path at once: one conflict, no 500', async () => {
  const other = connect(t.url, t.schema)
  for (let i = 0; i < 20; i++) {
    const r = await Promise.allSettled([createDoc(db, { path: `n${i}`, body: '' }), createDoc(other, { path: `n${i}`, body: '' })])
    expect(r.filter((x) => x.status === 'rejected').map((x) => String((x as PromiseRejectedResult).reason))).toEqual([expect.stringMatching(/already exists/)])
  }
  await other.end()
})
