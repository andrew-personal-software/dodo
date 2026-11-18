import { afterEach, beforeEach, expect, test } from 'vitest'
import type { Db } from './db'
import { createDoc, deleteDoc, loadIndex } from './docs'
import { searchDocs, snippetOf } from './search'
import { testDb } from './testdb'

let t: Awaited<ReturnType<typeof testDb>>
let db: Db
beforeEach(async () => { t = await testDb(); db = t.db })
afterEach(async () => { await t.drop() })

test('fuzzy finds a path with a typo; full text finds body words', async () => {
  await createDoc(db, { path: 'deploy/mini-pc', body: '# Mini PC\nrun systemctl restart' })
  const index = await loadIndex(db)
  expect((await searchDocs(db, index, 'minipc'))[0].path).toBe('deploy/mini-pc')
  expect((await searchDocs(db, index, 'systemctl'))[0]).toMatchObject({ path: 'deploy/mini-pc', snippet: expect.stringContaining('systemctl') })
})
test('short and odd queries never throw', async () => {
  await createDoc(db, { path: 'a', body: 'x' })
  for (const q of ['a', 'ab', '"', 'a AND', '-x*', '', "'; drop", '\\']) await expect(searchDocs(db, await loadIndex(db), q)).resolves.toBeDefined()
})
test('project filter and deleted docs', async () => {
  await createDoc(db, { path: 'one', body: 'needle', projects: ['SPAR'] }); await createDoc(db, { path: 'two', body: 'needle' })
  await createDoc(db, { path: 'three', body: 'needle' }); await deleteDoc(db, 'three')
  expect((await searchDocs(db, await loadIndex(db), 'needle', { project: 'spar' })).map((h) => h.path)).toEqual(['one'])
  expect((await searchDocs(db, await loadIndex(db), 'needle')).map((h) => h.path).sort()).toEqual(['one', 'two'])
})
test('LIKE wildcards in the query are literal', async () => {
  await createDoc(db, { path: 'p1', body: '500 items' }); await createDoc(db, { path: 'p2', body: 'axb' })
  const index = await loadIndex(db)
  expect(await searchDocs(db, index, '50%')).toEqual([])
  expect(await searchDocs(db, index, 'a_b')).toEqual([])
})
test('snippetOf finds the match case-insensitively', () => {
  expect(snippetOf('a b c systemctl d e', 'SystemCtl')).toContain('systemctl')
  const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
  const s = snippetOf(long, 'w20')
  expect(s.startsWith('…') && s.endsWith('…')).toBe(true)
  expect(s.split(' ').length).toBeLessThanOrEqual(13)
})
