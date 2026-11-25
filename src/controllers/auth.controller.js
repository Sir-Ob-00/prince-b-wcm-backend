import { pool } from '../db/pool.js';
import { verifyPassword, hashPassword } from '../models/staff.js';
import { csrfToken } from '../middleware/auth.js';
import { config } from '../config/index.js';
import { writeAudit } from '../models/audit.js';
// Use a real dummy hash to keep unknown-account attempts on the password-check path.
const dummyHash = await hashPassword('unusable-dummy-account-password');
export async function currentSession(req, res) {
  const staff = req.session.staffId ? (await pool.query('SELECT id,name,email,role FROM staff WHERE id=$1 AND is_active', [req.session.staffId])).rows[0] : null;
  res.json({ user: staff || null, csrfToken: csrfToken(req) });
}
export async function signIn(req, res) {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string' || email.length > 254 || password.length > 256) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const { rows } = await pool.query('SELECT * FROM staff WHERE email=$1', [email.trim().toLowerCase()]);
  const valid = await verifyPassword(password, rows[0]?.password_hash || dummyHash);
  if (!rows[0] || !valid || !rows[0].is_active) {
    await writeAudit({action:'auth.sign_in_failed',level:'warning',targetType:'auth'});
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }
  await new Promise((resolve,reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
  req.session.staffId = rows[0].id;
  await writeAudit({actor:rows[0],action:'auth.signed_in',targetType:'auth'});
  res.json({ user: { id: rows[0].id,name:rows[0].name,email:rows[0].email,role:rows[0].role }, csrfToken: csrfToken(req) });
}
export async function signOut(req, res) {
  const actor=req.session.staffId?(await pool.query('SELECT id,email FROM staff WHERE id=$1',[req.session.staffId])).rows[0]:null;
  if(actor)await writeAudit({actor,action:'auth.signed_out',targetType:'auth'});
  await new Promise((resolve,reject) => req.session.destroy(error => error ? reject(error) : resolve()));
  res.clearCookie('wcm.sid', { path:'/', httpOnly:true, sameSite:'strict', secure:config.production });
  res.status(204).end();
}
