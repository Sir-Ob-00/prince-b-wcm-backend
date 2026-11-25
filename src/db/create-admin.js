import { randomUUID } from 'node:crypto';
import { pool } from './pool.js';
import { hashPassword } from '../models/staff.js';
import { writeAudit } from '../models/audit.js';
try {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase(), password = process.env.ADMIN_PASSWORD;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !password || password.length < 12 || password.length > 256) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD (12–256 characters) in your private environment.');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(729316)');
    const first=!(await client.query('SELECT 1 FROM staff LIMIT 1')).rowCount;
    const id=randomUUID();
    await client.query('INSERT INTO staff(id,email,password_hash,role) VALUES($1,$2,$3,$4)',[id,email,await hashPassword(password),first?'super_admin':'admin']);
    await writeAudit({action:'user.created',targetType:'staff',targetId:id,details:{bootstrap:first,role:first?'super_admin':'admin'}},client);
    await client.query('COMMIT');
    console.log(first?'Super admin created. Remove ADMIN_PASSWORD from your environment.':'Admin created. Remove ADMIN_PASSWORD from your environment.');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
} catch(error) { console.error(error.code === '23505' ? 'That staff account already exists; it was not changed.' : error.message); process.exitCode = 1; }
finally { await pool.end(); }
