import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { chmodSync } from 'node:fs';
const source = process.env.HUB_TASK_DB;
const destination = process.argv[2];
if (!source || source === ':memory:' || !destination) throw new Error('Set HUB_TASK_DB and pass a new backup file path');
const db = new DatabaseSync(resolve(source), { readOnly: true });
try { db.prepare('VACUUM INTO ?').run(resolve(destination)); chmodSync(resolve(destination), 0o600); console.log('Task database snapshot created'); } finally { db.close(); }
