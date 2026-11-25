import { Router } from 'express';
import { requireStaff,requireSuperAdmin } from '../middleware/auth.js';
import { listAudit } from '../models/audit.js';
export const logsRouter=Router();
logsRouter.use(requireStaff,requireSuperAdmin);
logsRouter.get('/',async(req,res)=>res.json(await listAudit(req.query)));
