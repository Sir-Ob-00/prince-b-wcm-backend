import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(729315)');
    await client.query('CREATE TABLE IF NOT EXISTS wcm_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())');
    const directory = new URL('./migrations/', import.meta.url);
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      if ((await client.query('SELECT name FROM wcm_migrations WHERE name=$1', [name])).rowCount) continue;
      await client.query(await readFile(new URL(name, directory), 'utf8'));
      await client.query('INSERT INTO wcm_migrations(name) VALUES($1)', [name]);
    }
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await migrate(); console.log('Migrations complete'); }
  catch(error) { console.error('Migration failed:', error.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
