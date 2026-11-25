import { pool } from '../db/pool.js';
import { z } from 'zod';
export async function writeAudit({ actor, action, level='info', targetType=null, targetId=null, details={} }, db=pool) {
  // Callers pass explicit event metadata, never request bodies, passwords or tokens.
  await db.query('INSERT INTO audit_logs(actor_id,actor_email,action,level,target_type,target_id,details) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [actor?.id || null, actor?.email || null, action, level, targetType, targetId, details]);
}
const querySchema=z.object({page:z.coerce.number().int().min(1).max(10000).default(1),q:z.string().trim().max(120).default(''),level:z.enum(['all','info','warning','error']).default('all')});
export async function listAudit(query) {
  const {page,q,level}=querySchema.parse(query),values=[],clauses=[];
  if(level!=='all'){values.push(level);clauses.push(`level=$${values.length}`);}
  if(q){values.push('%'+q.replace(/[\\%_]/g,'\\$&')+'%');const p='$'+values.length;clauses.push(`(action ILIKE ${p} OR actor_email ILIKE ${p} OR target_type ILIKE ${p} OR target_id ILIKE ${p})`);}
  const where=clauses.length?'WHERE '+clauses.join(' AND '):'';
  const total=Number((await pool.query(`SELECT count(*) FROM audit_logs ${where}`,values)).rows[0].count);
  const {rows}=await pool.query(`SELECT id,actor_email,action,level,target_type,target_id,details,created_at FROM audit_logs ${where} ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET $${values.length+1}`,[...values,(page-1)*50]);
  return {items:rows,total,page,pageSize:50};
}
