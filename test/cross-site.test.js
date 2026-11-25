import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import request from 'supertest';

if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to a dedicated database ending in _test.');
process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET=randomBytes(32).toString('hex');
process.env.NODE_ENV='production';
process.env.PUBLIC_API_URL='https://prince-b-wcm-backend.onrender.com';
process.env.PUBLIC_SITE_URL='https://jaydeladem.github.io/prince-b-realty-consult/';
process.env.CORS_ORIGINS='https://jaydeladem.github.io,http://127.0.0.1:8765,http://127.0.0.1:5500';
const { pool }=await import('../src/db/pool.js');
const { migrate }=await import('../src/db/migrate.js');
const { app, sessionStore }=await import('../src/app.js');
const origin='https://jaydeladem.github.io';
function fromSite(req){return req.set('Origin',origin).set('X-Forwarded-Proto','https');}
function cookie(response){return response.headers['set-cookie'][0].split(';')[0];}
before(async()=>{await migrate();});
after(async()=>{sessionStore.close();await pool.end();});

test('GitHub Pages credentialed preflight allows the real methods and CSRF header',async()=>{
  for(const method of ['POST','PATCH','DELETE']){
    const r=await fromSite(request(app).options('/api/v1/auth/sign-in'))
      .set('Access-Control-Request-Method',method)
      .set('Access-Control-Request-Headers','content-type,x-csrf-token').expect(204);
    assert.equal(r.headers['access-control-allow-origin'],origin);
    assert.equal(r.headers['access-control-allow-credentials'],'true');
    assert(r.headers['access-control-allow-methods'].split(',').includes(method));
    assert.match(r.headers['access-control-allow-headers'],/X-CSRF-Token/i);
  }
  const denied=await request(app).get('/api/v1/auth/session').set('Origin','https://untrusted.example').expect(200);
  assert.equal(denied.headers['access-control-allow-origin'],undefined);
  assert.equal(denied.headers['access-control-allow-credentials'],undefined);
});

test('production session cookies support partitioned HTTPS continuity; sign-out clears the same attributes',async()=>{
  const r=await fromSite(request(app).get('/api/v1/auth/session')).expect(200);
  const header=r.headers['set-cookie'][0];
  for(const attr of ['HttpOnly','Secure','SameSite=None','Partitioned','Path=/'])assert(header.includes(attr));
  const again=await fromSite(request(app).get('/api/v1/auth/session')).set('Cookie',cookie(r)).expect(200);
  assert.equal(again.body.csrfToken,r.body.csrfToken);
  await fromSite(request(app).post('/api/v1/auth/sign-in')).set('Cookie',cookie(r)).send({email:'absent@example.test',password:'not-real-credentials'}).expect(403);
  await fromSite(request(app).post('/api/v1/auth/sign-in')).set('Cookie',cookie(r)).set('X-CSRF-Token',r.body.csrfToken).send({email:'absent@example.test',password:'not-real-credentials'}).expect(401);
  const out=await fromSite(request(app).post('/api/v1/auth/sign-out')).set('Cookie',cookie(r)).set('X-CSRF-Token',r.body.csrfToken).expect(204);
  for(const attr of ['HttpOnly','Secure','SameSite=None','Partitioned','Path=/'])assert(out.headers['set-cookie'][0].includes(attr));
  assert.match(out.headers['set-cookie'][0],/Expires=Thu, 01 Jan 1970/);
  await fromSite(request(app).get('/api/v1/admin/properties')).set('Cookie',cookie(r)).expect(401);
});

test('backend root links to static admin and no longer pretends to host frontend files',async()=>{
  const r=await request(app).get('/').expect(200);
  assert.equal(r.body.admin,process.env.PUBLIC_SITE_URL+'admin/index.html');
  await request(app).get('/admin/config.js').expect(404);
});
