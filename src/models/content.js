import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { validateContent } from './validation.js';
import { writeAudit } from './audit.js';

function table(kind) {
  if (!['properties','gallery','faqs'].includes(kind)) throw new Error('Invalid content type');
  return kind;
}
export function serialize(kind, row) {
  const result = { ...row.data, id: row.id, publication_status: row.publication_status, sort_order: row.sort_order, created_at: row.created_at, updated_at: row.updated_at };
  if (kind === 'properties') {
    result.slug = row.slug;
    result.url = new URL('property-details.html?id=' + encodeURIComponent(row.slug), config.siteUrl).href;
  }
  return result;
}
export async function listContent(kind, admin = false) {
  const { rows } = await pool.query(`SELECT * FROM ${table(kind)} ${admin ? '' : "WHERE publication_status='published'"} ORDER BY sort_order, id`);
  return rows.map(row => serialize(kind, row));
}
export async function getContent(kind, id, admin = false) {
  const column = kind === 'properties' && !admin ? 'slug' : 'id';
  const { rows } = await pool.query(`SELECT * FROM ${table(kind)} WHERE ${column}=$1 ${admin ? '' : "AND publication_status='published'"}`, [id]);
  return rows[0] ? serialize(kind, rows[0]) : null;
}
export async function createContent(kind, input, id, actor=null) {
  id ??= kind==='faqs'?'faq-'+randomUUID():randomUUID();
  const data = validateContent(kind, input);
  const columns = kind === 'properties' ? 'id, slug, publication_status, sort_order, data' : 'id, publication_status, sort_order, data';
  const values = kind === 'properties' ? [id, data.slug, data.publication_status, data.sort_order, data] : [id, data.publication_status, data.sort_order, data];
  const placeholders = values.map((_,i) => '$' + (i+1)).join(',');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const { rows } = await client.query(`INSERT INTO ${table(kind)} (${columns}) VALUES (${placeholders}) RETURNING *`, values);
    await writeAudit({actor,action:'content.created',targetType:kind,targetId:id,details:{publication:data.publication_status}},client);
    await client.query('COMMIT');return serialize(kind, rows[0]);
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
export async function updateContent(kind, id, input, actor=null) {
  // Row lock prevents two PATCH requests from overwriting each other's fields.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM ${table(kind)} WHERE id=$1 FOR UPDATE`, [id]);
    if (!rows[0]) { await client.query('ROLLBACK'); return null; }
    if (kind === 'properties' && input.slug !== undefined && input.slug !== rows[0].slug) {
      throw Object.assign(new Error('Property slugs are permanent so existing links keep working.'), { status: 400 });
    }
    const data = validateContent(kind, { ...rows[0].data, ...input });
    const result = await client.query(`UPDATE ${table(kind)} SET data=$2, publication_status=$3, sort_order=$4, updated_at=now() WHERE id=$1 RETURNING *`, [id, data, data.publication_status, data.sort_order]);
    const action=rows[0].publication_status===data.publication_status?'content.updated':data.publication_status==='published'?'content.published':'content.unpublished';
    await writeAudit({actor,action,targetType:kind,targetId:id,details:{fields:Object.keys(input),from:rows[0].publication_status,to:data.publication_status}},client);
    await client.query('COMMIT');
    return serialize(kind, result.rows[0]);
  } catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function deleteContent(kind, id, actor=null) {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const result=await client.query(`DELETE FROM ${table(kind)} WHERE id=$1`,[id]);
    if(result.rowCount)await writeAudit({actor,action:'content.deleted',targetType:kind,targetId:id},client);
    await client.query('COMMIT');return result.rowCount>0;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}
