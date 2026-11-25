import { listContent, getContent, createContent, updateContent, deleteContent } from '../models/content.js';
export function contentController(kind, admin = false) {
  return {
    list: async (req,res) => {
      let items = await listContent(kind, admin);
      if (!admin && kind === 'properties') {
        if (req.query.featured === 'true') items = items.filter(item => item.featured);
        if (req.query.category) items = items.filter(item => item.property_type === req.query.category);
        if (req.query.q) { const q = String(req.query.q).toLowerCase(); items = items.filter(item => `${item.title} ${item.display_location}`.toLowerCase().includes(q)); }
      }
      // Public FAQ consumers share a small, stable plain-text response contract.
      if(!admin&&kind==='faqs')items=items.map(({id,category,question,answer,featured})=>({id,category,question,answer,featured}));
      res.json(items);
    },
    get: async (req,res) => { const item = await getContent(kind, req.params.id || req.params.slug, admin); item ? res.json(item) : res.status(404).json({ error:'Content not found.' }); },
    create: async (req,res) => res.status(201).json(await createContent(kind, req.body, undefined,req.staff)),
    update: async (req,res) => { const item = await updateContent(kind, req.params.id, req.body,req.staff); item ? res.json(item) : res.status(404).json({ error:'Content not found.' }); },
    remove: async (req,res) => { (await deleteContent(kind, req.params.id,req.staff)) ? res.status(204).end() : res.status(404).json({ error:'Content not found.' }); },
  };
}
