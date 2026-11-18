import { afterEach, beforeEach, expect, test } from 'vitest'
import { connect } from '@/core/db'
import { createDoc } from '@/core/docs'
import { testDb } from '@/core/testdb'
import { startState } from '@/server/state'
import { PUT as putDoc } from './doc/route'
import { GET as getDocs, POST as postDocs } from './docs/route'

let t: Awaited<ReturnType<typeof testDb>>
beforeEach(async () => {
  t = await testDb()
  globalThis.__dodo = await startState(t.db)
})
afterEach(async () => {
  globalThis.__dodo = undefined
  await t.drop()
})

const jsonReq = (body: unknown, method = 'POST', query = '') =>
  new Request(`http://x/api${query}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

test('PUT with a stale hash is 409; with onConflict copy it is 200 and names the copy', async () => {
  const created = await (await postDocs(jsonReq({ path: 'a', body: 'one' }))).json()
  await putDoc(jsonReq({ body: 'two', baseHash: created.doc.bodyHash }, 'PUT', '?path=a'))
  const stale = await putDoc(jsonReq({ body: 'three', baseHash: created.doc.bodyHash }, 'PUT', '?path=a'))
  expect(stale.status).toBe(409)
  const copy = await (await putDoc(jsonReq({ body: 'three', baseHash: created.doc.bodyHash, clientId: 'c', onConflict: 'copy' }, 'PUT', '?path=a'))).json()
  expect(copy).toMatchObject({ conflictOf: 'a', doc: { path: 'a.conflict-1' } })
})
test('bad JSON shapes are 400', async () => {
  const bad = new Request('http://x/api', { method: 'POST', body: 'nope' })
  expect((await postDocs(bad)).status).toBe(400)
  expect((await postDocs(jsonReq({ path: 'a', body: 'x', projects: 'SPAR' }))).status).toBe(400)
  expect((await putDoc(jsonReq({ body: 1 }, 'PUT', '?path=a'))).status).toBe(400)
})
test('a write from another process (the other slot) reaches the index', async () => {
  const get = () => getDocs(new Request('http://x/api/docs'))
  const before = (await get()).headers.get('etag')
  const other = connect(t.url, t.schema)
  await createDoc(other, { path: 'from-other-slot', body: '' })
  await other.end()
  await expect.poll(async () => (await (await get()).json()).docs.map((d: { path: string }) => d.path), { timeout: 2000 }).toEqual(['from-other-slot'])
  expect((await get()).headers.get('etag')).not.toBe(before)
})
