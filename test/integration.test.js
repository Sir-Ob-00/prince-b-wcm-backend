import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import request from 'supertest';
import sharp from 'sharp';
import { ipKeyGenerator } from 'express-rate-limit';

// Never run these destructive fixture resets against a development/production DB.
if (!process.env.TEST_DATABASE_URL || !new URL(process.env.TEST_DATABASE_URL).pathname.endsWith('_test')) throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL database whose name ends in _test.');
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
process.env.NODE_ENV = 'test';
const { pool } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { seed } = await import('../src/db/seed.js');
const { seedFaqs } = await import('../src/db/seed-faqs.js');
const { hashPassword } = await import('../src/models/staff.js');
const { app, sessionStore } = await import('../src/app.js');
const { config } = await import('../src/config/index.js');
const { signInLimiter } = await import('../src/routes/auth.routes.js');
const password = randomBytes(24).toString('hex'), email='test-staff@example.test';
let server, base;
const property = JSON.parse(await readFile(new URL('../src/db/seeds/properties.json', import.meta.url),'utf8'))[0];
const { id: seedId, ...propertyInput } = property;
const galleryInput={title:'Test gallery',caption:'Caption',alt:'Accessible image description',image_url:propertyInput.images[0],publication_status:'draft',sort_order:20};
before(async()=>{
  await migrate(); await migrate();
  await pool.query('TRUNCATE properties,gallery,faqs,faq_seed_records,media,audit_logs,staff,sessions');
  await seed(); await seed();
  await pool.query('INSERT INTO staff(id,email,password_hash) VALUES($1,$2,$3)',[randomUUID(),email,await hashPassword(password)]);
  await pool.query("INSERT INTO staff(id,name,email,password_hash,role) VALUES($1,'Owner',$2,$3,'super_admin')",[randomUUID(),'owner@example.test',await hashPassword(password)]);
  server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  config.apiUrl=base;
});
// Give each test scenario its own login-attempt budget; the limiter remains active.
beforeEach(()=>{for(const ip of ['127.0.0.1','::ffff:127.0.0.1','::1'])signInLimiter.resetKey(ipKeyGenerator(ip));});
after(async()=>{ if(server) await new Promise(resolve=>server.close(resolve)); sessionStore.close(); await pool.end(); });
async function staff() {
  const agent=request.agent(app); const state=await agent.get('/api/v1/auth/session').expect(200);
  const login=await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email,password}).expect(200);
  return {agent,token:login.body.csrfToken};
}
let ownerSession;
async function owner(){
  if(ownerSession)return ownerSession;
  const agent=request.agent(app),state=await agent.get('/api/v1/auth/session').expect(200);
  const login=await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:'owner@example.test',password}).expect(200);
  assert.equal(login.body.user.role,'super_admin');
  ownerSession={agent,token:login.body.csrfToken,user:login.body.user,cookieJar:{value:login.headers['set-cookie'][0].split(';')[0]}};return ownerSession;
}
test('health, migrated content, ordering, idempotent seed and CORS',async()=>{
  await request(app).get('/api/v1/health').expect(200);
  const props=(await request(app).get('/api/v1/properties').expect(200)).body;
  assert.deepEqual(props.map(p=>p.id),['house-1','apartment-1','land-1']);
  assert.equal(props[0].price,'GHS 850,000'); assert.equal(props[0].price_ghs,850000);
  assert.match(props[0].url,/property-details.html\?id=house-1$/);
  assert.match(props[0].images[0],/^https:\/\/jaydeladem.github.io\/prince-b-realty-consult\/images\//);
  const gallery=(await request(app).get('/api/v1/gallery').expect(200)).body;
  assert.equal(gallery.length,6); assert.equal(gallery[0].alt,'Modern residential house'); assert.equal(gallery[5].title,'Property Inspection');
  for(const origin of ['https://jaydeladem.github.io','http://127.0.0.1:8765','http://127.0.0.1:5500']) {
    const result=await request(app).get('/api/v1/properties').set('Origin',origin).expect(200);
    assert.equal(result.headers['access-control-allow-origin'],origin); assert.equal(result.headers['access-control-allow-credentials'],'true');
  }
  const denied=await request(app).get('/api/v1/properties').set('Origin','https://untrusted.example').expect(200);
  assert.equal(denied.headers['access-control-allow-origin'],undefined);
});

test('every admin content method rejects anonymous callers; sign-in and CSRF protected',async()=>{
  for(const kind of ['properties','gallery']) for(const [method,path] of [['get',''],['post',''],['get','/house-1'],['patch','/house-1'],['delete','/house-1']]) await request(app)[method]('/api/v1/admin/'+kind+path).send({}).expect(401);
  await request(app).post('/api/v1/auth/sign-in').send({email,password}).expect(403);
  const {agent,token}=await staff();
  const state=await agent.get('/api/v1/auth/session').expect(200); assert.equal(state.body.user.email,email);
  const cookie=state.headers['set-cookie']?.[0]; if(cookie) assert.match(cookie,/HttpOnly/);
  await agent.post('/api/v1/admin/gallery').send(galleryInput).expect(403);
  await agent.post('/api/v1/auth/sign-out').set('X-CSRF-Token',token).expect(204);
  await agent.get('/api/v1/admin/properties').expect(401);
});

test('property and gallery create/edit/publish/unpublish/delete; stable slugs and validation',async()=>{
  const {agent,token}=await staff();
  for(const kind of ['properties','gallery']) {
    const input=kind==='properties'?{...propertyInput,slug:'test-property',publication_status:'draft'}:galleryInput;
    const created=(await agent.post('/api/v1/admin/'+kind).set('X-CSRF-Token',token).send(input).expect(201)).body;
    const path='/api/v1/admin/'+kind+'/'+created.id;
    assert(!(await request(app).get('/api/v1/'+kind)).body.some(p=>p.id===created.id));
    if(kind==='properties') await request(app).get('/api/v1/properties/test-property').expect(404);
    await agent.get(path).expect(200);
    await agent.patch(path).set('X-CSRF-Token',token).send({title:'Edited title',publication_status:'published'}).expect(200);
    const publicItems=(await request(app).get('/api/v1/'+kind)).body; assert.equal(publicItems.find(p=>p.id===created.id).title,'Edited title');
    if(kind==='properties') {
      await request(app).get('/api/v1/properties/test-property').expect(200);
      await agent.patch(path).set('X-CSRF-Token',token).send({slug:'changed-link'}).expect(400);
      await agent.patch(path).set('X-CSRF-Token',token).send({images:['javascript:alert(1)']}).expect(400);
    }
    await agent.patch(path).set('X-CSRF-Token',token).send({publication_status:'draft'}).expect(200);
    assert(!(await request(app).get('/api/v1/'+kind)).body.some(p=>p.id===created.id));
    await agent.delete(path).set('X-CSRF-Token',token).expect(204); await agent.get(path).expect(404);
  }
});

test('roles gate every user/log operation, while admins retain content and upload permissions',async()=>{
  const regular=await staff(),superAdmin=await owner();
  for(const path of ['/api/v1/admin/users','/api/v1/admin/logs']){
    await request(app).get(path).expect(401);await regular.agent.get(path).expect(403);await superAdmin.agent.get(path).expect(200);
  }
  for(const [method,path] of [['post',''],['patch','/'+superAdmin.user.id],['delete','/'+superAdmin.user.id]]){
    await regular.agent[method]('/api/v1/admin/users'+path).set('X-CSRF-Token',regular.token).send({name:'Attempt',role:'super_admin'}).expect(403);
  }
  await regular.agent.get('/api/v1/admin/properties').expect(200);
  await regular.agent.get('/api/v1/admin/gallery').expect(200);
  const sample=await sharp({create:{width:10,height:10,channels:3,background:'#123b32'}}).png().toBuffer();
  await regular.agent.post('/api/v1/admin/media').set('X-CSRF-Token',regular.token).attach('image',sample,'admin-upload.png').expect(201);
  const users=(await superAdmin.agent.get('/api/v1/admin/users')).body;
  assert(users.every(user=>!('password_hash'in user)&&!('password'in user)));
  await superAdmin.agent.post('/api/v1/admin/users').send({}).expect(403);
  await superAdmin.agent.delete('/api/v1/admin/users/'+superAdmin.user.id).set('X-CSRF-Token',superAdmin.token).expect(400);
  await superAdmin.agent.delete('/api/v1/admin/users/'+superAdmin.user.id.toUpperCase()).set('X-CSRF-Token',superAdmin.token).expect(400);
  await superAdmin.agent.patch('/api/v1/admin/users/'+superAdmin.user.id).set('X-CSRF-Token',superAdmin.token).send({role:'admin'}).expect(400);
});

test('super admin creates, edits, resets passwords, deactivates and deletes users; sessions revoked immediately',async()=>{
  const {agent,token}=await owner();
  const created=(await agent.post('/api/v1/admin/users').set('X-CSRF-Token',token).send({name:'New administrator',email:'new-admin@example.test',password,role:'admin'}).expect(201)).body;
  const path='/api/v1/admin/users/'+created.id;
  await agent.post('/api/v1/admin/users').set('X-CSRF-Token',token).send({name:'Duplicate',email:'new-admin@example.test',password}).expect(409);
  const newAgent=request.agent(app);let state=await newAgent.get('/api/v1/auth/session');
  await newAgent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:created.email,password}).expect(200);
  await newAgent.get('/api/v1/admin/properties').expect(200);
  await agent.patch(path).set('X-CSRF-Token',token).send({name:'Edited administrator',is_active:false}).expect(200);
  await newAgent.get('/api/v1/admin/properties').expect(401);
  const changedPassword=randomBytes(24).toString('hex');
  await agent.patch(path).set('X-CSRF-Token',token).send({is_active:true,password:changedPassword,role:'super_admin'}).expect(200);
  state=await newAgent.get('/api/v1/auth/session');
  await newAgent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:created.email,password}).expect(401);
  await newAgent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:created.email,password:changedPassword}).expect(200);
  await newAgent.get('/api/v1/admin/logs').expect(200);
  await agent.delete(path).set('X-CSRF-Token',token).expect(204);await agent.get(path).expect(404);await newAgent.get('/api/v1/admin/properties').expect(401);
  const logs=(await agent.get('/api/v1/admin/logs?q='+created.id).expect(200)).body;
  assert(logs.items.some(log=>log.action==='user.created'));assert(logs.items.some(log=>log.action==='user.updated'));assert(logs.items.some(log=>log.action==='user.deleted'));
  const serialized=JSON.stringify(logs);assert(!serialized.includes(password));assert(!serialized.includes(changedPassword));assert(!serialized.includes('password_hash'));
});

test('image uploads validate bytes and size, persist in PostgreSQL, and follow publication visibility',async()=>{
  const {agent,token}=await owner();const photo=await sharp({create:{width:60,height:40,channels:3,background:'#123b32'}}).png().toBuffer();
  await request(app).post('/api/v1/admin/media').attach('image',photo,'photo.png').expect(401);
  await agent.post('/api/v1/admin/media').attach('image',photo,'photo.png').expect(403);
  await agent.post('/api/v1/admin/media').set('X-CSRF-Token',token).attach('image',Buffer.from('<svg onload=alert(1)></svg>'),'photo.png').expect(400);
  await agent.post('/api/v1/admin/media').set('X-CSRF-Token',token).attach('image',Buffer.alloc(5*1024*1024+1),'oversize.png').expect(400);
  const result=(await agent.post('/api/v1/admin/media').set('X-CSRF-Token',token).attach('image',photo,'photo.png').expect(201)).body;
  const path=new URL(result.url).pathname;
  await request(app).get(path).expect(404);
  const preview=await agent.get(path).expect(200);assert.match(preview.headers['content-type'],/image\/webp/);assert.equal(preview.headers['cross-origin-resource-policy'],'cross-origin');
  assert((await pool.query('SELECT octet_length(bytes) AS size FROM media WHERE id=$1',[result.id])).rows[0].size>0);
  const created=(await agent.post('/api/v1/admin/properties').set('X-CSRF-Token',token).send({...propertyInput,slug:'uploaded-photo',images:[result.url],publication_status:'published'}).expect(201)).body;
  await request(app).get(path).expect(200);
  await agent.patch('/api/v1/admin/properties/'+created.id).set('X-CSRF-Token',token).send({publication_status:'draft'}).expect(200);await request(app).get(path).expect(404);
  const gallery=(await agent.post('/api/v1/admin/gallery').set('X-CSRF-Token',token).send({...galleryInput,image_url:result.url,publication_status:'published'}).expect(201)).body;
  await request(app).get(path).expect(200);
  await agent.delete('/api/v1/admin/gallery/'+gallery.id).set('X-CSRF-Token',token).expect(204);await agent.delete('/api/v1/admin/properties/'+created.id).set('X-CSRF-Token',token).expect(204);await request(app).get(path).expect(404);
  const logs=(await agent.get('/api/v1/admin/logs?q='+result.id)).body;assert(logs.items.some(log=>log.action==='media.uploaded'));
});

test('login abuse is rate-limited and log filtering/pagination stays read-only',async()=>{
  const agent=request.agent(app),state=await agent.get('/api/v1/auth/session');
  for(let attempt=0;attempt<10;attempt++)await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:'unknown@example.test',password:'wrong-password'}).expect(401);
  await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email,password}).expect(429);
  const superAdmin=await owner();const result=(await superAdmin.agent.get('/api/v1/admin/logs?level=warning&q=sign_in_failed&page=1').expect(200)).body;
  assert(result.total>=10);assert.equal(result.pageSize,50);assert(result.items.every(log=>log.level==='warning'&&log.action==='auth.sign_in_failed'));
  await superAdmin.agent.get('/api/v1/admin/logs?page=-1').expect(400);
  await superAdmin.agent.delete('/api/v1/admin/logs').expect(404);
});

test('concurrent super-admin changes cannot remove the last active super admin',async()=>{
  const superAdmin=await owner(),second=(await superAdmin.agent.post('/api/v1/admin/users').set('X-CSRF-Token',superAdmin.token).send({name:'Second owner',email:'second-owner@example.test',password,role:'super_admin'}).expect(201)).body;
  const agent=request.agent(app),state=await agent.get('/api/v1/auth/session'),login=await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:second.email,password}).expect(200);
  const results=await Promise.all([
    superAdmin.agent.patch('/api/v1/admin/users/'+second.id).set('X-CSRF-Token',superAdmin.token).send({role:'admin'}),
    agent.patch('/api/v1/admin/users/'+superAdmin.user.id).set('X-CSRF-Token',login.body.csrfToken).send({role:'admin'}),
  ]);
  // A losing request is rejected either by role authorization or immediate session revocation.
  assert.equal(results.filter(result=>result.status===200).length,1);
  assert(results.some(result=>[401,403].includes(result.status)));
  assert.equal(Number((await pool.query("SELECT count(*) FROM staff WHERE role='super_admin' AND is_active")).rows[0].count),1);
  // Restore the isolated fixture owner for any later test scenarios.
  await pool.query("UPDATE staff SET role='super_admin' WHERE id=$1",[superAdmin.user.id]);
  await pool.query('DELETE FROM staff WHERE id=$1',[second.id]);ownerSession=null;
});

test('FAQ seed preserves all 43 original records and exposes the public contract in source order',async()=>{
  const original=JSON.parse(await readFile(new URL('../src/db/seeds/faqs.json',import.meta.url),'utf8'));
  assert.equal(original.length,43);
  const response=await request(app).get('/api/v1/faqs').set('Origin','https://jaydeladem.github.io').expect(200);
  assert.equal(response.headers['access-control-allow-origin'],'https://jaydeladem.github.io');
  assert.deepEqual(response.body,original.map(({id,category,question,answer,featured=false})=>({id,category,question,answer,featured})));
  assert.equal((await pool.query('SELECT count(*) FROM faq_seed_records')).rows[0].count,'43');
});

test('FAQ API protects admin writes, keeps IDs stable and follows draft/publish/edit/unpublish/delete lifecycle',async()=>{
  for(const [method,suffix] of [['get',''],['post',''],['get','/faq-01'],['patch','/faq-01'],['delete','/faq-01']])await request(app)[method]('/api/v1/admin/faqs'+suffix).send({}).expect(401);
  const {agent,token}=await staff();
  await agent.post('/api/v1/admin/faqs').send({}).expect(403);
  await agent.post('/api/v1/admin/faqs').set('X-CSRF-Token',token).send({category:'Test',question:'Question?',answer:'   '}).expect(400);
  const body={category:'Test category',question:'A new question?',answer:'  Approved paragraph.\n\nSecond paragraph.\n\n\u2022 First item\n\u2022 Second item\n',sort_order:900,featured:true};
  const item=(await agent.post('/api/v1/admin/faqs').set('X-CSRF-Token',token).send(body).expect(201)).body;
  assert.match(item.id,/^faq-[0-9a-f-]+$/);assert.equal(item.publication_status,'draft');assert.equal(item.answer,body.answer);
  assert(!(await request(app).get('/api/v1/faqs')).body.some(record=>record.id===item.id));
  const path='/api/v1/admin/faqs/'+item.id;
  await agent.patch(path).set('X-CSRF-Token',token).send({id:'faq-replacement'}).expect(400);
  await agent.patch(path).set('X-CSRF-Token',token).send({publication_status:'published'}).expect(200);
  assert.equal((await request(app).get('/api/v1/faqs')).body.find(record=>record.id===item.id).answer,body.answer);
  const changed='Changed approved answer.\n\n\u2022 Confirmed detail';
  const updated=(await agent.patch(path).set('X-CSRF-Token',token).send({question:'Edited question?',answer:changed,sort_order:1}).expect(200)).body;
  assert.equal(updated.id,item.id);const published=(await request(app).get('/api/v1/faqs')).body;assert.equal(published.find(record=>record.id===item.id).answer,changed);assert(published.findIndex(record=>record.id===item.id)<published.findIndex(record=>record.id==='faq-03'));
  await agent.patch(path).set('X-CSRF-Token',token).send({publication_status:'draft'}).expect(200);assert(!(await request(app).get('/api/v1/faqs')).body.some(record=>record.id===item.id));
  await agent.delete(path).set('X-CSRF-Token',token).expect(204);await agent.get(path).expect(404);
});

test('FAQ-only reseed preserves staff edits, order, featured flags, drafts and deliberate deletion, even concurrently',async()=>{
  const {agent,token}=await staff();
  await agent.patch('/api/v1/admin/faqs/faq-01').set('X-CSRF-Token',token).send({question:'Staff-edited question',answer:'Staff-edited answer\n\n\u2022 Preserved bullet',sort_order:700,featured:true,publication_status:'draft'}).expect(200);
  await agent.delete('/api/v1/admin/faqs/faq-43').set('X-CSRF-Token',token).expect(204);
  assert.deepEqual(await seedFaqs(),{inserted:0,skipped:43});await seed();await Promise.all([seedFaqs(),seedFaqs()]);
  const edited=(await agent.get('/api/v1/admin/faqs/faq-01').expect(200)).body;assert.equal(edited.question,'Staff-edited question');assert.equal(edited.answer,'Staff-edited answer\n\n\u2022 Preserved bullet');assert.equal(edited.featured,true);assert.equal(edited.sort_order,700);assert.equal(edited.publication_status,'draft');
  await agent.get('/api/v1/admin/faqs/faq-43').expect(404);assert(!(await request(app).get('/api/v1/faqs')).body.some(record=>['faq-01','faq-43'].includes(record.id)));
  assert.equal((await pool.query("SELECT count(*) FROM faq_seed_records WHERE record_id='faq-43'")).rows[0].count,'1');
});
