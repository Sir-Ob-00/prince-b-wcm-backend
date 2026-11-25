import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInContext } from 'node:vm';
import request from 'supertest';
import { JSDOM } from 'jsdom';
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
const siteRoot = new URL('../../', import.meta.url);
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
    assert.equal(result.headers['access-control-allow-origin'],origin); assert.equal(result.headers['access-control-allow-credentials'],undefined);
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
async function waitFor(check) {
  for(let i=0;i<150;i++) { if(await check()) return; await new Promise(r=>setTimeout(r,10)); }
  throw new Error('Timed out waiting for UI state');
}
async function website(page, query='', failing=false) {
  const dom=new JSDOM(await readFile(new URL(page,siteRoot),'utf8'),{url:'http://127.0.0.1:8765/prince-b-realty-consult/'+page+query,runScripts:'outside-only'});
  const w=dom.window; w.AbortSignal=AbortSignal; w.HTMLElement.prototype.scrollIntoView=function(){};w.requestAnimationFrame=callback=>{callback();return 1;};
  const chats=[];
  w.fetch=async(url,options)=>{
    if(String(url).includes('property-chatbot-89ed.onrender.com')) {
      chats.push(JSON.parse(options.body));
      return {ok:true,json:async()=>({reply:'Hello from PrinBot',listings:[],demo:true,moderation:'clean'})};
    }
    if(failing) throw new Error('Simulated API outage');
    return fetch(url,options);
  };
  w.eval(await readFile(new URL('js/config.js',siteRoot),'utf8')); w.WCM.apiBaseUrl=base+'/api/v1';
  runInContext(await readFile(new URL('js/script.js',siteRoot),'utf8'),dom.getInternalVMContext()); runInContext(await readFile(new URL('js/catalogue.js',siteRoot),'utf8'),dom.getInternalVMContext());
  if(page==='gallery.html') w.eval(await readFile(new URL('js/gallery.js',siteRoot),'utf8'));
  if(w.document.querySelector('script[src="js/faqs.js"]')) {
    w.eval(await readFile(new URL('js/faqs.js',siteRoot),'utf8'));
    await waitFor(()=>Array.from(w.document.querySelectorAll('[data-faqs]')).every(mount=>mount.getAttribute('aria-busy')==='false'));
  }
  return {dom,w,chats};
}
test('public frontend reads live content: cards, featured, filters, detail links, gallery and PrinBot',async()=>{
  const {dom,w,chats}=await website('properties.html');
  await waitFor(()=>w.document.querySelectorAll('.property-item').length===3);
  const search=w.document.querySelector('#property-search'); search.value='East Legon'; search.dispatchEvent(new w.Event('input'));
  assert.equal([...w.document.querySelectorAll('.property-item')].filter(p=>p.style.display!=='none').length,1);
  search.value=''; search.dispatchEvent(new w.Event('input')); w.document.querySelector('[data-category=land]').click();
  assert.equal([...w.document.querySelectorAll('.property-item')].filter(p=>p.style.display!=='none')[0].dataset.propertyId,'land-1');
  assert.match(w.document.querySelector('.property-info a').href,/\/prince-b-realty-consult\/property-details.html\?id=house-1$/);
  w.document.querySelector('.chat-launcher').click(); assert.equal(w.document.querySelector('.property-chat').hidden,false);
  w.document.querySelector('.chat-starter').click(); await waitFor(()=>w.document.querySelector('.chat-messages').textContent.includes('Hello from PrinBot'));
  assert.equal(chats[0].message,'Show me houses for sale'); assert.equal(w.document.querySelector('.chat-demo'),null);
  w.document.querySelector('.chat-close').click(); assert(w.document.querySelector('.property-chat').hidden); dom.window.close();
  const featured=await website('index.html'); await waitFor(()=>featured.w.document.querySelectorAll('.property-item').length===3); featured.dom.window.close();
  const detail=await website('property-details.html','?id=house-1'); await waitFor(()=>!detail.w.document.querySelector('#property-details-content').hidden);
  assert.equal(detail.w.document.querySelector('#detail-price').textContent,'GHS 850,000'); assert.equal(detail.w.document.querySelectorAll('.property-thumbnail').length,4); detail.dom.window.close();
  const gallery=await website('gallery.html'); await waitFor(()=>gallery.w.document.querySelectorAll('.gallery-card').length===6);
  gallery.w.document.querySelector('.gallery-open').click(); assert(gallery.w.document.querySelector('.lightbox').classList.contains('open')); gallery.dom.window.close();
});
test('published edits appear after website refresh; seed does not overwrite staff edits',async()=>{
  const {agent,token}=await staff();
  await agent.patch('/api/v1/admin/properties/house-1').set('X-CSRF-Token',token).send({title:'Updated live title'}).expect(200);
  await seed();
  const page=await website('properties.html'); await waitFor(()=>page.w.document.querySelectorAll('.property-item').length===3);
  assert.match(page.w.document.querySelector('.property-grid').textContent,/Updated live title/); page.dom.window.close();
  await agent.patch('/api/v1/admin/properties/house-1').set('X-CSRF-Token',token).send({title:propertyInput.title}).expect(200);
});
test('editable titles render as text, validation rejects unsafe input, sessions persist in PostgreSQL',async()=>{
  const {agent,token}=await staff();
  await agent.patch('/api/v1/admin/properties/house-1').set('X-CSRF-Token','not-a-token').send({title:'Ignored'}).expect(403);
  await agent.patch('/api/v1/admin/properties/house-1').set('X-CSRF-Token',token).send({title:'<img src=x onerror=alert(1)>'}).expect(200);
  const page=await website('properties.html'); await waitFor(()=>page.w.document.querySelectorAll('.property-item').length===3);
  assert.equal(page.w.document.querySelector('.property-info h3').textContent,'<img src=x onerror=alert(1)>');
  assert.equal(page.w.document.querySelector('.property-info h3 img'),null); page.dom.window.close();
  await agent.patch('/api/v1/admin/properties/house-1').set('X-CSRF-Token',token).send({title:propertyInput.title}).expect(200);
  const stored=(await pool.query('SELECT sess FROM sessions WHERE sess::jsonb ? $1',[ 'staffId' ])).rows;
  assert(stored.length>0); assert(!JSON.stringify(stored).includes(password));
});
test('frontend distinguishes API outage, empty catalogue and unpublished property',async()=>{
  const outage=await website('properties.html','',true); await waitFor(()=>outage.w.document.querySelector('.property-grid').textContent.includes('temporarily unavailable')); outage.dom.window.close();
  const detail=await website('property-details.html','?id=not-published'); await waitFor(()=>!detail.w.document.querySelector('#property-not-found').hidden); assert.equal(detail.w.document.querySelector('#property-not-found h2').textContent,'Property Not Found'); detail.dom.window.close();
  const {agent,token}=await staff();
  const all=(await agent.get('/api/v1/admin/properties')).body;
  for(const item of all) await agent.patch('/api/v1/admin/properties/'+item.id).set('X-CSRF-Token',token).send({publication_status:'draft'}).expect(200);
  const empty=await website('properties.html'); await waitFor(()=>empty.w.document.querySelector('.property-grid').textContent.includes('No properties are currently published')); empty.dom.window.close();
  for(const item of all) await agent.patch('/api/v1/admin/properties/'+item.id).set('X-CSRF-Token',token).send({publication_status:'published'}).expect(200);
});
async function adminPage(path,cookieJar={value:''}) {
  const login=path.startsWith('/admin/login');
  const dom=new JSDOM(await readFile(new URL('../../admin/'+(login?'login.html':'index.html'),import.meta.url),'utf8'),{url:base+path,runScripts:'outside-only'}),w=dom.window;
  w.AbortSignal=AbortSignal;w.HTMLElement.prototype.scrollIntoView=function(){};w.confirm=()=>true;
  const redirects=[]; let requests=0;
  w.fetch=async(path,options={})=>{
    requests++;
    const response=await fetch(new URL(path,base),{...options,headers:{...options.headers,...(cookieJar.value?{Cookie:cookieJar.value}:{})}});
    const setCookie=response.headers.get('set-cookie');if(setCookie)cookieJar.value=setCookie.split(';')[0];return response;
  };
  for(const file of ['api.js','shared.js',...(login?[]:['editor.js','management.js'])])w.eval(await readFile(new URL('../../admin/'+file,import.meta.url),'utf8'));
  w.WCMAdmin.siteUrl='https://jaydeladem.github.io/prince-b-realty-consult/';
  w.WCMAdmin.redirect=(path,replace)=>redirects.push({path,replace});
  await w.eval(await readFile(new URL('../../admin/'+(login?'login.js':'admin.js'),import.meta.url),'utf8'));
  return {dom,w,redirects,cookieJar,requests:()=>requests};
}
function submitForm(w,form,button=form.querySelector('button[type=submit]')) {
  form.dispatchEvent(new w.SubmitEvent('submit',{bubbles:true,cancelable:true,submitter:button}));
}
let sharedUiSession;
async function uiSignIn() {
  if (sharedUiSession) {
    const session=await fetch(base+'/api/v1/auth/session',{headers:{Cookie:sharedUiSession.value}}).then(r=>r.json());
    if(session.user) return sharedUiSession;
  }
  const page=await adminPage('/admin/login'),doc=page.w.document;
  doc.querySelector('#email').value=email;doc.querySelector('#password').value=password;
  submitForm(page.w,doc.querySelector('#sign-in-form'));await waitFor(()=>page.redirects.length>0);
  assert.equal(page.redirects[0].path,'/admin');page.dom.window.close();sharedUiSession=page.cookieJar;return page.cookieJar;
}
test('admin page routes and brand assets resolve; login handles bad credentials, show/hide and duplicate submits',async()=>{
  for(const path of ['/admin','/admin/login','/admin/properties','/admin/gallery','/admin/assets/logo.png','/admin/assets/property.avif'])await request(app).get(path).expect(200);
  const page=await adminPage('/admin/login?next=https://evil.example/'),doc=page.w.document;
  assert.equal(doc.querySelector('.sign-in-submit').disabled,false);
  doc.querySelector('#toggle-password').click();assert.equal(doc.querySelector('#password').type,'text');doc.querySelector('#toggle-password').click();assert.equal(doc.querySelector('#password').type,'password');
  doc.querySelector('#email').value=email;doc.querySelector('#password').value='wrong-password';
  submitForm(page.w,doc.querySelector('#sign-in-form'));await waitFor(()=>doc.querySelector('#feedback').textContent.includes('incorrect'));
  assert.equal(doc.querySelector('.sign-in-submit').disabled,false);
  doc.querySelector('#password').value=password;const count=page.requests();
  submitForm(page.w,doc.querySelector('#sign-in-form'));submitForm(page.w,doc.querySelector('#sign-in-form'));
  assert(doc.querySelector('.sign-in-submit').disabled);await waitFor(()=>page.redirects.length>0);
  assert.equal(page.requests()-count,1);assert.equal(page.redirects[0].path,'/admin');page.dom.window.close();
});
test('overview reports database counts and recent rows; navigation, search and filters use real lists',async()=>{
  const jar=await uiSignIn(),page=await adminPage('/admin',jar),doc=page.w.document;
  const stats=[...doc.querySelectorAll('.stat-card strong')].map(node=>node.textContent);assert.deepEqual(stats,['3','0','6']);assert.equal(doc.querySelectorAll('.recent-table tbody tr').length,8);
  doc.querySelector('nav a[href="/admin/properties"]').click();await waitFor(()=>doc.querySelectorAll('.property-table tbody tr').length===3);
  assert.equal(page.w.location.pathname,'/admin/properties');assert.equal(doc.querySelector('nav a[aria-current=page]').pathname,'/admin/properties');
  const search=doc.querySelector('#content-search');search.value='East Legon';search.dispatchEvent(new page.w.Event('input'));assert.equal(doc.querySelectorAll('.property-table tbody tr').length,1);
  doc.querySelector('[data-filter=draft]').click();assert(doc.querySelector('#items').textContent.includes('No items match'));
  doc.querySelector('#menu-toggle').click();assert(doc.body.classList.contains('nav-open'));doc.querySelector('#close-menu').click();assert(!doc.body.classList.contains('nav-open'));
  doc.querySelector('nav a[href="/admin/gallery"]').click();await waitFor(()=>doc.querySelectorAll('.gallery-admin-card').length===6);assert.equal(doc.querySelector('.card-meta>span:last-child').textContent,'Order 0');
  page.dom.window.close();
});
test('new admin editors create/edit/publish/unpublish/delete both kinds and public website refresh follows publication',async()=>{
  const jar=await uiSignIn();
  for(const kind of ['properties','gallery']){
    const page=await adminPage('/admin/'+kind,jar),w=page.w,doc=w.document;
    doc.querySelector('.page-heading a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);
    const form=doc.querySelector('#content-form');
    submitForm(w,form);await waitFor(()=>doc.querySelector('[aria-invalid=true]'));assert(doc.querySelector('#error-title').textContent);
    const values=kind==='properties'?{title:'Dashboard property',slug:'dashboard-test-property',location:'East Legon',display_location:'East Legon, Accra',status:'active',price:'GHS 700,000',price_ghs:'700000',description:'Published through staff dashboard',images:propertyInput.images[0]}:{title:'Dashboard gallery',alt:'Staff-created gallery image',image_url:propertyInput.images[0],caption:'Published through staff dashboard'};
    for(const [key,value] of Object.entries(values))form.elements.namedItem(key).value=value;
    const mediaInput=form.elements.namedItem(kind==='properties'?'images':'image_url');mediaInput.dispatchEvent(new w.Event('input'));assert.equal(doc.querySelector('#image-preview').hidden,false);assert.equal(doc.querySelector('#image-preview').src,propertyInput.images[0]);
    if(kind==='properties') {
      mediaInput.value='http://invalid.example/image.jpg';submitForm(w,form);await waitFor(()=>doc.querySelector('#error-images').textContent.includes('HTTPS'));
      mediaInput.value=propertyInput.images[0];
    }
    submitForm(w,form);submitForm(w,form);await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#items')?.textContent.includes(values.title));
    let records=await fetch(base+'/api/v1/admin/'+kind,{headers:{Cookie:jar.value}}).then(r=>r.json());let created=records.find(p=>p.title===values.title);assert(created);assert.equal(created.publication_status,'draft');
    const edit=()=>doc.querySelector(`[data-item-id="${created.id}"] a`);
    edit().click();await waitFor(()=>!doc.querySelector('#editor').hidden);form.elements.title.value=values.title+' edited';values.title+=' edited';
    submitForm(w,form);await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#items')?.textContent.includes(values.title));
    edit().click();await waitFor(()=>!doc.querySelector('#editor').hidden);submitForm(w,form,doc.querySelector('#publish-item'));
    await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#feedback').textContent.includes('Published successfully'));
    assert(doc.querySelector('#feedback a').href.includes(kind==='properties'?'property-details.html':'gallery.html#our-gallery'));
    const publicPage=await website(kind==='properties'?'properties.html':'gallery.html');await waitFor(()=>publicPage.w.document.body.textContent.includes(values.title));publicPage.dom.window.close();
    edit().click();await waitFor(()=>!doc.querySelector('#editor').hidden);assert.equal(form.elements.namedItem('slug')?.readOnly??true,true);
    doc.querySelector('#unpublish-item').click();await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#feedback').textContent.includes('Unpublished'));
    const hiddenPage=await website(kind==='properties'?'properties.html':'gallery.html');await waitFor(()=>hiddenPage.w.document.querySelector(kind==='properties'?'.property-item':'.gallery-card'));assert(!hiddenPage.w.document.body.textContent.includes(values.title));hiddenPage.dom.window.close();
    edit().click();await waitFor(()=>!doc.querySelector('#editor').hidden);w.confirm=()=>false;doc.querySelector('#delete-item').click();assert(!doc.querySelector('#editor').hidden);
    w.confirm=()=>true;doc.querySelector('#delete-item').click();await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false'&&!doc.querySelector(`[data-item-id="${created.id}"]`));
    await request(app).get('/api/v1/'+kind+(kind==='properties'?'/dashboard-test-property':'')).expect(kind==='properties'?404:200);
    page.dom.window.close();
  }
});
test('expired sessions and anonymous dashboard return to login; sign-out clears access',async()=>{
  const anonymous=await adminPage('/admin/gallery');assert(anonymous.redirects[0].path.startsWith('/admin/login?next='));anonymous.dom.window.close();
  const jar=await uiSignIn(),page=await adminPage('/admin',jar);
  await pool.query("DELETE FROM sessions WHERE sess->>'staffId' IS NOT NULL");
  page.w.document.querySelector('nav a[href="/admin/properties"]').click();await waitFor(()=>page.redirects.length>0);assert(page.redirects[0].path.includes('/admin/login?expired=1'));
  page.dom.window.close();
  const signedInJar=await uiSignIn(),signedIn=await adminPage('/admin',signedInJar);
  signedIn.w.document.querySelector('#sign-out').click();await waitFor(()=>signedIn.redirects.length>0);assert.equal(signedIn.redirects[0].path,'/admin/login');
  await request(app).get('/api/v1/admin/properties').set('Cookie',signedInJar.value).expect(401);signedIn.dom.window.close();
});
let ownerSession;
async function owner(){
  if(ownerSession)return ownerSession;
  const agent=request.agent(app),state=await agent.get('/api/v1/auth/session').expect(200);
  const login=await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:'owner@example.test',password}).expect(200);
  assert.equal(login.body.user.role,'super_admin');
  ownerSession={agent,token:login.body.csrfToken,user:login.body.user,cookieJar:{value:login.headers['set-cookie'][0].split(';')[0]}};return ownerSession;
}
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
test('super-admin Users and System logs screens manage accounts safely; regular admins see neither page',async()=>{
  const regularJar=await uiSignIn(),denied=await adminPage('/admin/users',regularJar);
  assert(denied.w.document.querySelector('#super-admin-nav').hidden);assert(denied.w.document.querySelector('#view').textContent.includes('Only a super admin'));assert.equal(denied.redirects.length,0);denied.dom.window.close();
  const superAdmin=await owner(),page=await adminPage('/admin/users',superAdmin.cookieJar),w=page.w,doc=w.document;
  assert.equal(doc.querySelector('#super-admin-nav').hidden,false);
  doc.querySelector('.page-heading a').click();await waitFor(()=>doc.querySelector('#user-form'));
  const form=doc.querySelector('#user-form');submitForm(w,form);assert(form.querySelector('[aria-invalid]'));
  for(const [key,value] of Object.entries({name:'UI account',email:'ui-account@example.test',password,role:'admin'}))form.elements.namedItem(key).value=value;
  submitForm(w,form);submitForm(w,form);await waitFor(()=>doc.querySelector('#view').getAttribute('aria-busy')==='false'&&doc.querySelector('#view').textContent.includes('ui-account@example.test')&&!doc.querySelector('#user-form'));
  const row=()=>[...doc.querySelectorAll('[data-user-id]')].find(row=>row.textContent.includes('ui-account@example.test'));
  row().querySelector('a').click();await waitFor(()=>doc.querySelector('#user-form'));let editor=doc.querySelector('#user-form');editor.elements.namedItem('name').value='UI account edited';submitForm(w,editor);
  await waitFor(()=>doc.querySelector('#view').getAttribute('aria-busy')==='false'&&row()?.textContent.includes('UI account edited'));
  row().querySelector('a').click();await waitFor(()=>doc.querySelector('#delete-user'));w.confirm=()=>false;doc.querySelector('#delete-user').click();assert(doc.querySelector('#user-form'));
  w.confirm=()=>true;doc.querySelector('#delete-user').click();await waitFor(()=>doc.querySelector('#view').getAttribute('aria-busy')==='false'&&!row()&&!doc.querySelector('#user-form'));
  doc.querySelector('a[href="/admin/logs"]').click();await waitFor(()=>doc.querySelector('#logs-filter'));
  const filters=doc.querySelector('#logs-filter');filters.elements.namedItem('q').value='user.deleted';submitForm(w,filters);
  await waitFor(()=>doc.querySelector('#view').getAttribute('aria-busy')==='false'&&w.location.search.includes('user.deleted'));
  assert(doc.querySelector('tbody').textContent.includes('user.deleted'));assert(!doc.querySelector('tbody').textContent.includes(password));page.dom.window.close();
});
test('image file chooser uploads through multipart API and inserts a usable preview URL without losing URL entry',async()=>{
  const superAdmin=await owner(),page=await adminPage('/admin/properties?new=1',superAdmin.cookieJar),w=page.w,doc=w.document;
  const image=await sharp({create:{width:40,height:30,channels:3,background:'#c49a42'}}).png().toBuffer(),fetchPage=w.fetch;
  let uploaded=0;
  w.fetch=async(path,options)=>{
    if(path==='/api/v1/admin/media'){
      assert(options.body instanceof w.FormData);assert(!('Content-Type'in options.headers));
      assert.equal(options.body.get('image').name,'upload.png');
      const result=await superAdmin.agent.post(path).set('X-CSRF-Token',options.headers['X-CSRF-Token']).attach('image',image,'upload.png').expect(201);uploaded++;
      return {ok:true,status:201,json:async()=>result.body};
    }return fetchPage(path,options);
  };
  const input=doc.querySelector('#upload-images');Object.defineProperty(input,'files',{value:[new w.File([image],'upload.png',{type:'image/png'})]});
  input.dispatchEvent(new w.Event('change'));await waitFor(()=>doc.querySelector('.upload-feedback').textContent.includes('Save or publish'));
  assert.equal(uploaded,1);assert.match(doc.querySelector('[name=images]').value,/\/api\/v1\/media\//);assert.equal(doc.querySelector('#image-preview').hidden,false);assert.equal(doc.querySelector('.primary-save').disabled,false);
  assert(doc.querySelector('[name=images]'));page.dom.window.close();
});
test('concurrent super-admin changes cannot remove the last active super admin',async()=>{
  const superAdmin=await owner(),second=(await superAdmin.agent.post('/api/v1/admin/users').set('X-CSRF-Token',superAdmin.token).send({name:'Second owner',email:'second-owner@example.test',password,role:'super_admin'}).expect(201)).body;
  const agent=request.agent(app),state=await agent.get('/api/v1/auth/session'),login=await agent.post('/api/v1/auth/sign-in').set('X-CSRF-Token',state.body.csrfToken).send({email:second.email,password}).expect(200);
  const results=await Promise.all([
    superAdmin.agent.patch('/api/v1/admin/users/'+second.id).set('X-CSRF-Token',superAdmin.token).send({role:'admin'}),
    agent.patch('/api/v1/admin/users/'+superAdmin.user.id).set('X-CSRF-Token',login.body.csrfToken).send({role:'admin'}),
  ]);
  assert.deepEqual(results.map(result=>result.status).sort(),[200,403]);
  assert.equal(Number((await pool.query("SELECT count(*) FROM staff WHERE role='super_admin' AND is_active")).rows[0].count),1);
  // Restore the isolated fixture owner for any later test scenarios.
  await pool.query("UPDATE staff SET role='super_admin' WHERE id=$1",[superAdmin.user.id]);
  await pool.query('DELETE FROM staff WHERE id=$1',[second.id]);ownerSession=null;
});
test('FAQ seed preserves all 43 original records and exposes the public contract in source order',async()=>{
  const original=JSON.parse(await readFile(new URL('faqs.json',siteRoot),'utf8'));
  assert.equal(original.length,43);
  assert.equal(await readFile(new URL('../src/db/seeds/faqs.json',import.meta.url),'utf8'),await readFile(new URL('faqs.json',siteRoot),'utf8'));
  const response=await request(app).get('/api/v1/faqs').set('Origin','https://jaydeladem.github.io').expect(200);
  assert.equal(response.headers['access-control-allow-origin'],'https://jaydeladem.github.io');
  assert.deepEqual(response.body,original.map(({id,category,question,answer,featured=false})=>({id,category,question,answer,featured})));
  assert.equal((await pool.query('SELECT count(*) FROM faq_seed_records')).rows[0].count,'43');
  const page=await website('faq.html','?test=seed#faq-24');
  assert.equal(page.w.document.querySelectorAll('.faq-item').length,43);
  assert(page.w.document.getElementById('faq-24').open);
  assert.equal(page.w.document.querySelector('#faq-24 summary h3').textContent,original.find(item=>item.id==='faq-24').question);page.dom.window.close();
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
test('FAQ dashboard manages order/feature/publication and both public FAQ views consume live changes',async()=>{
  const jar=await uiSignIn(),page=await adminPage('/admin/faqs',jar),w=page.w,doc=w.document;
  assert.equal(doc.querySelectorAll('.faq-admin-table tbody tr').length,43);
  const search=doc.querySelector('#content-search');search.value='General Questions';search.dispatchEvent(new w.Event('input'));assert(doc.querySelectorAll('.faq-admin-table tbody tr').length<43);
  doc.querySelector('.page-heading a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);
  assert(doc.querySelector('.preview-card').hidden);const form=doc.querySelector('#content-form');
  const answer='  A staff-approved introduction.\n\n\u2022 Approved fact one\n\u2022 Approved fact two\n\nFinal paragraph.  ';
  for(const [key,value] of Object.entries({category:'Dashboard FAQ test',question:'Can I manage FAQs here?',answer,sort_order:'900'}))form.elements.namedItem(key).value=value;
  form.elements.namedItem('featured').checked=true;submitForm(w,form);
  await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false');
  let row=[...doc.querySelectorAll('.faq-admin-table tr')].find(row=>row.textContent.includes('Can I manage FAQs here?'));assert(row);const id=row.dataset.itemId;
  assert(row.textContent.includes('Draft'));row.querySelector('a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);
  assert.equal(form.elements.namedItem('answer').value,answer);assert(doc.querySelector('.faq-reference').textContent.includes(id));
  submitForm(w,form,doc.querySelector('#publish-item'));await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false');
  assert(doc.querySelector('#feedback a').href.endsWith('faq.html#'+id));
  const publicPage=await website('faq.html','?test=dashboard#'+id);assert(publicPage.w.document.getElementById(id).open);assert.deepEqual([...publicPage.w.document.querySelectorAll('#'+id+' li')].map(node=>node.textContent),['Approved fact one','Approved fact two']);publicPage.dom.window.close();
  const home=await website('index.html');assert.equal(home.w.document.querySelector('[data-faqs=featured] .faq-item').id,id);home.dom.window.close();
  row=doc.querySelector('[data-item-id="'+id+'"]');row.querySelector('a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);form.elements.question.value='Updated staff question';form.elements.answer.value='Updated public answer';submitForm(w,form);
  await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false');assert(doc.querySelector('[data-item-id="'+id+'"]').textContent.includes('Updated staff question'));
  assert.equal((await request(app).get('/api/v1/faqs')).body.find(record=>record.id===id).answer,'Updated public answer');
  doc.querySelector('[data-item-id="'+id+'"] a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);doc.querySelector('#unpublish-item').click();await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false');
  const privateHome=await website('index.html');assert.equal(privateHome.w.document.querySelector('[data-faqs=featured] .faq-item'),null);privateHome.dom.window.close();
  doc.querySelector('[data-item-id="'+id+'"] a').click();await waitFor(()=>!doc.querySelector('#editor').hidden);w.confirm=()=>false;doc.querySelector('#delete-item').click();assert(!doc.querySelector('#editor').hidden);w.confirm=()=>true;doc.querySelector('#delete-item').click();await waitFor(()=>doc.querySelector('#editor').hidden&&doc.querySelector('#view').getAttribute('aria-busy')==='false');assert(!doc.querySelector('[data-item-id="'+id+'"]'));page.dom.window.close();
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
