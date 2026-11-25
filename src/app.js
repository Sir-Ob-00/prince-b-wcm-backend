import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import session from 'express-session';
import pgSession from 'connect-pg-simple';
import { ZodError } from 'zod';
import { config, sessionCookieAttributes } from './config/index.js';
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
// Exact frontend origins may send credentialed admin requests; CSRF still protects every write.
app.use('/api/v1', cors({ origin: (origin,done) => done(null, !origin || config.corsOrigins.includes(origin)), methods:['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders:['Content-Type','X-CSRF-Token'], credentials:true, maxAge:600 }));
app.use(express.json({ limit:'100kb' }));
app.get('/api/v1/health', async (req,res) => {
  try { await pool.query('SELECT 1'); res.json({ status:'ok', database:'connected' }); }
  catch { res.status(503).json({ status:'unavailable', database:'unavailable' }); }
});
const Store = pgSession(session);
export const sessionStore = new Store({ pool, tableName:'sessions', createTableIfMissing:false });
const sessionMiddleware = session({
  store: sessionStore, name:'wcm.sid', secret:config.secret, resave:false, saveUninitialized:false,
  cookie:{ ...sessionCookieAttributes, maxAge:8*60*60*1000 },
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
// The admin UI is deployed separately on GitHub Pages, not served from this repo.
app.get('/', (req,res) => res.json({ service:'Prince B WCM API', health:'/api/v1/health', admin:new URL('admin/index.html',config.siteUrl).href }));
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
