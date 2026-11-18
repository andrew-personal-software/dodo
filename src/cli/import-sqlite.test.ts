import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { createDoc, readDoc } from '../core/docs'
import { testDb } from '../core/testdb'
import { importSqlite } from './import-sqlite'

// The SQLite schema dodo had before Postgres (v2), copied from src/core/db.ts at main.
const OLD_MIGRATIONS = [
  `
  CREATE TABLE docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL,
    updated TEXT NOT NULL,
    client_id TEXT,
    deleted_at TEXT
  );
  CREATE UNIQUE INDEX docs_path ON docs (path) WHERE deleted_at IS NULL;
  CREATE UNIQUE INDEX docs_client_id ON docs (client_id) WHERE client_id IS NOT NULL;
  CREATE TABLE doc_projects (doc_id INTEGER NOT NULL REFERENCES docs(id), project TEXT NOT NULL, PRIMARY KEY (doc_id, project));
  CREATE TABLE files (id TEXT PRIMARY KEY, doc_id INTEGER NOT NULL REFERENCES docs(id), filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
  CREATE INDEX files_doc ON files (doc_id);
  CREATE VIRTUAL TABLE docs_fts USING fts5(path, body, content='docs', content_rowid='id', tokenize='trigram');
  CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
    INSERT INTO docs_fts (rowid, path, body) VALUES (new.id, new.path, new.body);
  END;
  CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
    INSERT INTO docs_fts (docs_fts, rowid, path, body) VALUES ('delete', old.id, old.path, old.body);
  END;
  CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
    INSERT INTO docs_fts (docs_fts, rowid, path, body) VALUES ('delete', old.id, old.path, old.body);
    INSERT INTO docs_fts (rowid, path, body) VALUES (new.id, new.path, new.body);
  END;
  `,
  // The clientId of the last write, so a retried write after a lost response is not a conflict.
  'ALTER TABLE docs ADD COLUMN write_client_id TEXT',
]


let t: Awaited<ReturnType<typeof testDb>>
let file: string
beforeEach(async () => {
  t = await testDb()
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dodo-import-')), 'dodo.db')
  const s = new DatabaseSync(file)
  for (const m of OLD_MIGRATIONS) s.exec(m)
  s.exec('PRAGMA user_version = 2')
  const doc = s.prepare('INSERT INTO docs (path, body, created, updated, client_id, deleted_at, write_client_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
  doc.run('a', '# A\nbody a', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 'c1', null, 'w1')
  doc.run('b', 'body b', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null, '2026-01-03T00:00:00Z', null)
  doc.run('c/d', 'body d', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', null, null, null)
  s.exec("INSERT INTO doc_projects VALUES (1, 'SPAR'), (3, 'CROW')")
  s.exec("INSERT INTO files VALUES ('f1', 1, 'x.png', 'image/png', 3, '2026-01-01T00:00:00Z')")
  s.close()
})
afterEach(async () => { await t.drop() })

test('copies every row with its id and matching counts', async () => {
  const counts = await importSqlite(file, t.db)
  expect(counts).toEqual([
    { table: 'docs', sqlite: 3, postgres: 3 },
    { table: 'doc_projects', sqlite: 2, postgres: 2 },
    { table: 'files', sqlite: 1, postgres: 1 },
  ])
  const a = await readDoc(t.db, 'a')
  expect(a).toMatchObject({ body: '# A\nbody a', projects: ['SPAR'], files: [{ id: 'f1', filename: 'x.png' }] })
  await expect(readDoc(t.db, 'b')).rejects.toThrow(/not found/)
  await createDoc(t.db, { path: 'new', body: '' })
  const [{ id }] = await t.db<{ id: number }[]>`SELECT id FROM docs WHERE path = 'new'`
  expect(id).toBe(4)
  await expect(importSqlite(file, t.db)).rejects.toThrow(/not empty/)
})
