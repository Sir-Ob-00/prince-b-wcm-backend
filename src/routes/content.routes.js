import { Router } from 'express';
import { requireStaff, requireCsrf } from '../middleware/auth.js';
import { contentController } from '../controllers/content.controller.js';
export function contentRoutes(kind) {
  const publicRouter = Router(), adminRouter = Router();
  const publicHandlers = contentController(kind), admin = contentController(kind, true);
  publicRouter.get('/', publicHandlers.list);
  if (kind === 'properties') publicRouter.get('/:slug', publicHandlers.get);
  adminRouter.use(requireStaff, requireCsrf);
  adminRouter.get('/', admin.list);
  adminRouter.post('/', admin.create);
  adminRouter.get('/:id', admin.get);
  adminRouter.patch('/:id', admin.update);
  adminRouter.delete('/:id', admin.remove);
  return { publicRouter, adminRouter };
}
