import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool.js';
export function csrfToken(req) {
  req.session.csrf ||= randomBytes(32).toString('hex');
  return req.session.csrf;
}
export function requireCsrf(req, res, next) {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  const supplied = req.get('X-CSRF-Token');
  const expected = req.session.csrf;
  if (!supplied || !expected || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return res.status(403).json({ error: 'Session expired or CSRF token missing. Reload the admin page and sign in again.' });
  }
  next();
}
export async function requireStaff(req, res, next) {
  if (!req.session.staffId) return res.status(401).json({ error: 'Sign in to manage content.' });
  const result = await pool.query('SELECT id,name,email,role FROM staff WHERE id=$1 AND is_active', [req.session.staffId]);
  if (!result.rows[0]) return res.status(401).json({ error: 'Staff account is no longer active.' });
  req.staff = result.rows[0];
  next();
}
export function requireSuperAdmin(req,res,next) {
  if(req.staff?.role!=='super_admin')return res.status(403).json({error:'Only a super admin can access this page.',code:'FORBIDDEN_ROLE'});
  next();
}
