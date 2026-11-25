import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { validateContent } from '../models/validation.js';
import { seedFaqsInTransaction } from './seed-faqs.js';
export async function seed() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(729317)');
    for (const kind of ['properties','gallery']) {
      const records = JSON.parse(await readFile(new URL(`./seeds/${kind}.json`, import.meta.url), 'utf8'));
      for (const { id, ...input } of records) {
        const data = validateContent(kind, input);
        // Insert only: rerunning never overwrites staff edits, publication or ordering.
        if (kind === 'properties') await client.query('INSERT INTO properties(id,slug,publication_status,sort_order,data) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING', [id,data.slug,data.publication_status,data.sort_order,data]);
        else await client.query('INSERT INTO gallery(id,publication_status,sort_order,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [id,data.publication_status,data.sort_order,data]);
      }
    }
    await seedFaqsInTransaction(client);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await seed(); console.log('Seed complete; existing content was not changed.'); }
  catch(error) { console.error('Seed failed:',error.message); process.exitCode=1; }
  finally { await pool.end(); }
}
