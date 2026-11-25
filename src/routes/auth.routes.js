import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { currentSession, signIn, signOut } from '../controllers/auth.controller.js';
import { requireCsrf } from '../middleware/auth.js';
export const authRouter = Router();
export const signInLimiter=rateLimit({ windowMs:15*60*1000, limit:10, standardHeaders:'draft-8', legacyHeaders:false, message:{error:'Too many sign-in attempts. Try again in 15 minutes.'} });
authRouter.get('/session', currentSession);
authRouter.post('/sign-in', signInLimiter, requireCsrf, signIn);
authRouter.post('/sign-out', requireCsrf, signOut);
