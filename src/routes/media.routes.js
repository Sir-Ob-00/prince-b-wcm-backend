import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import multer from 'multer';
import sharp from 'sharp';
import { rateLimit } from 'express-rate-limit';
import { pool } from '../db/pool.js';
import { config } from '../config/index.js';
import { requireStaff,requireCsrf } from '../middleware/auth.js';
import { writeAudit } from '../models/audit.js';
export const mediaAdminRouter=Router(),mediaPublicRouter=Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:5*1024*1024,files:1,fields:0,parts:1}});
mediaAdminRouter.post('/',requireStaff,requireCsrf,rateLimit({windowMs:15*60*1000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'Upload limit reached. Please try again in 15 minutes.'}}),upload.single('image'),async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose an image to upload.'});
  let processed;
  try{
    const image=sharp(req.file.buffer,{limitInputPixels:20000000,failOn:'warning'});
    const metadata=await image.metadata();
    if(!['jpeg','png','webp','avif','heif'].includes(metadata.format)||metadata.pages>1)throw new Error('Unsupported image');
    processed=await image.rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:82}).toBuffer({resolveWithObject:true});
  }catch(_){return res.status(400).json({error:'Upload a valid, non-animated JPEG, PNG, WebP or AVIF image, up to 5 MB and 20 megapixels.'});}
  const id=randomUUID(),url=new URL('/api/v1/media/'+id,config.apiUrl).href,client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query("INSERT INTO media(id,content_type,bytes,width,height,uploaded_by) VALUES($1,'image/webp',$2,$3,$4,$5)",[id,processed.data,processed.info.width,processed.info.height,req.staff.id]);
    await writeAudit({actor:req.staff,action:'media.uploaded',targetType:'media',targetId:id,details:{bytes:processed.data.length,width:processed.info.width,height:processed.info.height}},client);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  res.status(201).json({id,url,width:processed.info.width,height:processed.info.height});
});
mediaPublicRouter.get('/:id',async(req,res)=>{
  if(!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(req.params.id))return res.status(404).end();
  const url=new URL('/api/v1/media/'+req.params.id,config.apiUrl).href;
  const published=(await pool.query("SELECT EXISTS(SELECT 1 FROM properties WHERE publication_status='published' AND data->'images' ? $1) OR EXISTS(SELECT 1 FROM gallery WHERE publication_status='published' AND data->>'image_url'=$1) AS visible",[url])).rows[0].visible;
  let staff=false;
  if(!published&&req.session.staffId)staff=(await pool.query('SELECT 1 FROM staff WHERE id=$1 AND is_active',[req.session.staffId])).rowCount>0;
  if(!published&&!staff)return res.status(404).end();
  const item=(await pool.query('SELECT content_type,bytes FROM media WHERE id=$1',[req.params.id])).rows[0];
  if(!item)return res.status(404).end();
  // Recheck publication on every read so unpublishing also removes public access.
  res.set({'Content-Type':item.content_type,'Cross-Origin-Resource-Policy':'cross-origin','Cache-Control':'no-store','Content-Disposition':'inline'}).send(item.bytes);
});
