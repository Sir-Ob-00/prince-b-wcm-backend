import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { validateContent } from '../models/validation.js';
export async function seedFaqsInTransaction(client) {
  const faqs=JSON.parse(await readFile(new URL('./seeds/faqs.json',import.meta.url),'utf8'));
  if(!Array.isArray(faqs))throw new Error('FAQ seed must be an array');
  const seen=new Set();let inserted=0;
  for(let index=0;index<faqs.length;index++){
    const {id,...approved}=faqs[index];
    if(typeof id!=='string'||!/^faq-[A-Za-z0-9_-]+$/.test(id)||seen.has(id))throw new Error('FAQ seed contains an invalid or duplicate ID');
    seen.add(id);
    const data=validateContent('faqs',{...approved,publication_status:'published',sort_order:index});
    const claimed=await client.query("INSERT INTO faq_seed_records(seed_name,record_id) VALUES('client-faqs-v1',$1) ON CONFLICT DO NOTHING RETURNING record_id",[id]);
    if(!claimed.rowCount)continue;
    inserted+=(await client.query('INSERT INTO faqs(id,publication_status,sort_order,data) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[id,data.publication_status,data.sort_order,data])).rowCount;
  }
  return {inserted,skipped:faqs.length-inserted};
}
export async function seedFaqs() {
  const client=await pool.connect();
  try {
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(729317)');
    const result=await seedFaqsInTransaction(client);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try {console.log('FAQ seed complete:',await seedFaqs());}
  catch(error){console.error('FAQ seed failed:',error.message);process.exitCode=1;}
  finally{await pool.end();}
}
