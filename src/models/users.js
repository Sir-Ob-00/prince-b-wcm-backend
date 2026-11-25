import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword } from './staff.js';
import { writeAudit } from './audit.js';
const password=z.string().min(12,'Use at least 12 characters.').max(256);
const userSchema=z.object({name:z.string().trim().min(1).max(120),email:z.email().max(254).transform(s=>s.toLowerCase()),role:z.enum(['admin','super_admin']).default('admin'),is_active:z.boolean().default(true),password});
const patchSchema=userSchema.partial().strict();
export const userColumns='id,name,email,role,is_active,created_at,updated_at';
function fail(status,message){throw Object.assign(new Error(message),{status});}
export async function listUsers(){return (await pool.query(`SELECT ${userColumns} FROM staff ORDER BY created_at,id`)).rows;}
export async function getUser(id){return (await pool.query(`SELECT ${userColumns} FROM staff WHERE id=$1`,[id])).rows[0]||null;}
export async function changeUser(actor,operation,id,input={}) {
  const data=operation==='create'?userSchema.strict().parse(input):operation==='update'?patchSchema.parse(input):{};
  const encoded=data.password?await hashPassword(data.password):null;
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    // Serializes super-admin changes so concurrent demotions/deletions cannot lock out the owner.
    await client.query('SELECT pg_advisory_xact_lock(729316)');
    const authority=(await client.query('SELECT role,is_active FROM staff WHERE id=$1',[actor.id])).rows[0];
    if(!authority?.is_active||authority.role!=='super_admin')fail(403,'Only a super admin can manage users.');
    let result;
    if(operation==='create'){
      result=(await client.query(`INSERT INTO staff(id,name,email,role,is_active,password_hash) VALUES($1,$2,$3,$4,$5,$6) RETURNING ${userColumns}`,[randomUUID(),data.name,data.email,data.role,data.is_active,encoded])).rows[0];
    }else{
      const current=(await client.query('SELECT * FROM staff WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!current){await client.query('ROLLBACK');return null;}
      if(current.id===actor.id&&(operation==='delete'||data.role==='admin'||data.is_active===false))fail(400,'You cannot delete, deactivate or demote your own account.');
      const next={...current,...data};
      if(current.role==='super_admin'&&current.is_active&&(operation==='delete'||next.role!=='super_admin'||!next.is_active)){
        const others=Number((await client.query("SELECT count(*) FROM staff WHERE role='super_admin' AND is_active AND id<>$1",[id])).rows[0].count);
        if(!others)fail(400,'At least one active super admin must remain.');
      }
      if(operation==='delete'){await client.query('DELETE FROM staff WHERE id=$1',[id]);result={id};}
      else result=(await client.query(`UPDATE staff SET name=$2,email=$3,role=$4,is_active=$5,password_hash=$6,updated_at=now() WHERE id=$1 RETURNING ${userColumns}`,[id,next.name,next.email,next.role,next.is_active,encoded||current.password_hash])).rows[0];
      // Deleted, disabled, renamed or password/role-changed users must sign in again.
      if(operation==='delete'||data.password||next.role!==current.role||next.email!==current.email||next.is_active!==current.is_active)await client.query("DELETE FROM sessions WHERE sess->>'staffId'=$1",[id]);
    }
    await writeAudit({actor,action:'user.'+(operation==='create'?'created':operation==='delete'?'deleted':'updated'),targetType:'staff',targetId:result.id,details:{fields:Object.keys(data).filter(key=>key!=='password'),passwordChanged:!!data.password,role:result.role||null}},client);
    await client.query('COMMIT');return result;
  }catch(error){await client.query('ROLLBACK');if(error.code==='23505')fail(409,'A staff account with that email already exists.');throw error;}
  finally{client.release();}
}
