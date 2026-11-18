import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { cleanup } from '../cli/cleanup'
import { createDoc } from './docs'
import { addFile, removeFile } from './files'
import { testDb } from './testdb'

let t: Awaited<ReturnType<typeof testDb>>
let dir: string
beforeEach(async () => {
  t = await testDb()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-files-'))
  await createDoc(t.db, { path: 'a', body: '' })
})
afterEach(async () => { await t.drop() })

const old = new Date(Date.now() - 8 * 24 * 3600 * 1000)

test('removeFile drops the row and touches the file', async () => {
  const meta = await addFile(t.db, 'a', { filename: 'x.txt', data: new Uint8Array([1]) }, dir)
  fs.utimesSync(path.join(dir, meta.id), old, old)
  await removeFile(t.db, meta.id, dir)
  expect(fs.statSync(path.join(dir, meta.id)).mtimeMs).toBeGreaterThan(Date.now() - 60_000)
  await expect(removeFile(t.db, meta.id, dir)).rejects.toThrow(/not found/)
})
test('cleanup removes old orphans only', async () => {
  const kept = await addFile(t.db, 'a', { filename: 'x.txt', data: new Uint8Array([1]) }, dir)
  fs.utimesSync(path.join(dir, kept.id), old, old)
  fs.writeFileSync(path.join(dir, 'orphan-old'), ''); fs.utimesSync(path.join(dir, 'orphan-old'), old, old)
  fs.writeFileSync(path.join(dir, 'orphan-new'), '')
  expect(await cleanup(t.db, dir)).toBe(1)
  expect(fs.readdirSync(dir).sort()).toEqual([kept.id, 'orphan-new'].sort())
})
