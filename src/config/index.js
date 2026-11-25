export const config = {
  production: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL,
  secret: process.env.SESSION_SECRET,
  siteUrl: process.env.PUBLIC_SITE_URL || 'https://jaydeladem.github.io/prince-b-realty-consult/',
  apiUrl: process.env.PUBLIC_API_URL || (process.env.NODE_ENV === 'production' ? '' : `http://127.0.0.1:${process.env.PORT || 3000}`),
  corsOrigins: (process.env.CORS_ORIGINS || 'https://jaydeladem.github.io,http://127.0.0.1:8765,http://127.0.0.1:5500').split(',').map(s => s.trim()).filter(Boolean),
};
if (!config.databaseUrl) throw new Error('DATABASE_URL is required');
if (!config.secret || config.secret.length < 32 || config.secret.startsWith('replace-')) throw new Error('Set SESSION_SECRET to a random secret of at least 32 characters');
const site = new URL(config.siteUrl);
if (site.protocol !== 'https:' && !(site.protocol === 'http:' && ['127.0.0.1','localhost'].includes(site.hostname))) throw new Error('PUBLIC_SITE_URL must use HTTPS outside local development');
if(!config.apiUrl)throw new Error('Set PUBLIC_API_URL to the HTTPS origin of the WCM service.');
const api=new URL(config.apiUrl);
if(api.pathname!=='/'||api.search||api.hash||api.username||api.password||(api.protocol!=='https:'&&!(api.protocol==='http:'&&!config.production&&['127.0.0.1','localhost'].includes(api.hostname))))throw new Error('PUBLIC_API_URL must be an HTTPS origin (HTTP loopback is allowed locally), without a path or credentials.');

// Production admin is cross-site (GitHub Pages -> Render). Keep sessions server-side.
export const sessionCookieAttributes = {
  path: '/', httpOnly: true, secure: config.production,
  sameSite: config.production ? 'none' : 'strict',
  partitioned: config.production,
};
