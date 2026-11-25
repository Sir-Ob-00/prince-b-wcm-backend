import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config } from './config/index.js';
import { pool } from './db/pool.js';
import { authRouter } from './routes/auth.routes.js';
import { propertiesRoutes } from './routes/properties.routes.js';
import { galleryRoutes } from './routes/gallery.routes.js';
import { faqsRoutes } from './routes/faqs.routes.js';
import { usersRouter } from './routes/users.routes.js';
import { logsRouter } from './routes/logs.routes.js';
import { mediaAdminRouter,mediaPublicRouter } from './routes/media.routes.js';
import { writeAudit } from './models/audit.js';

export const app = express();
if (config.production) app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy:{directives:{'img-src':["'self'", 'https:', 'data:'], 'upgrade-insecure-requests': config.production ? [] : null}}, strictTransportSecurity:config.production }));
app.use('/api/v1', (req,res,next) => { res.set('Cache-Control','no-store'); next(); });
// Cross-origin access is read-only. Admin UI and cookies stay on the API origin.
app.use('/api/v1', cors({ origin: (origin,done) => done(null, !origin || config.corsOrigins.includes(origin)), methods:['GET'], credentials:false }));
app.use(express.json({ limit:'100kb' }));
app.get('/api/v1/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', database:'connected' }); }
  catch { res.status(503).json({ status:'unavailable', database:'unavailable' }); }
});
const Store = pgSession(session);
export const sessionStore = new Store({ pool, tableName:'sessions', createTableIfMissing:false });
const sessionMiddleware = session({
  store: sessionStore, name:'wcm.sid', secret:config.secret, resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, secure:config.production, sameSite:'strict', maxAge:8*60*60*1000 },
});
app.use('/api/v1/auth', sessionMiddleware, authRouter);
app.use('/api/v1/admin', sessionMiddleware);
app.use('/api/v1/properties', propertiesRoutes.publicRouter);
app.use('/api/v1/gallery', galleryRoutes.publicRouter);
app.use('/api/v1/faqs',faqsRoutes.publicRouter);
app.use('/api/v1/admin/properties', propertiesRoutes.adminRouter);
app.use('/api/v1/admin/gallery', galleryRoutes.adminRouter);
app.use('/api/v1/admin/faqs',faqsRoutes.adminRouter);
app.use('/api/v1/admin/users',usersRouter);
app.use('/api/v1/admin/logs',logsRouter);
app.use('/api/v1/admin/media',mediaAdminRouter);
app.use('/api/v1/media',sessionMiddleware,mediaPublicRouter);
const adminDirectory = fileURLToPath(new URL('../../admin/', import.meta.url));
app.get('/admin/config.js', (req,res) => {
  res.set('Cache-Control','no-store').type('application/javascript').send(`window.WCMAdmin=window.WCMAdmin||{};WCMAdmin.siteUrl=${JSON.stringify(config.siteUrl)};`);
});
app.get(['/admin/login','/admin/login/'], (req,res) => res.sendFile('login.html', { root:adminDirectory }));
app.get(['/admin','/admin/','/admin/properties','/admin/properties/','/admin/gallery','/admin/gallery/','/admin/faqs','/admin/faqs/','/admin/users','/admin/users/','/admin/logs','/admin/logs/'], (req,res) => res.sendFile('index.html', { root:adminDirectory }));
app.use('/admin', express.static(adminDirectory, { index:false }));
app.use((req,res) => res.status(404).json({ error:'Endpoint not found.' }));
app.use((error,req,res,next) => {
  if(error.name==='MulterError')return res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'Each image must be 5 MB or smaller.':'Choose one image per upload, with no extra form fields.'});
  if (error instanceof ZodError) return res.status(400).json({ error:'Please correct the marked fields.', fields:error.issues.map(issue => ({field:issue.path.join('.'), message:issue.message})) });
  if (error.code === '23505') return res.status(409).json({ error:'That property slug already exists. Choose a unique slug.' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({error:'Invalid JSON request.'});
  if (error.type === 'entity.too.large') return res.status(413).json({error:'Request is too large.'});
  if (error.status && error.status < 500) return res.status(error.status).json({ error:error.message });
  console.error('WCM request failed:', error.code || error.name);
  writeAudit({action:'system.request_failed',level:'error',targetType:'http',details:{method:req.method,path:req.path.slice(0,250),code:error.code||error.name}}).catch(()=>{});
  res.status(503).json({ error:'Content service temporarily unavailable. Please try again.' });
});
