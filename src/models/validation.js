import { z } from 'zod';
import { config } from '../config/index.js';
const text = z.string().trim().min(1).max(1000);
const mediaUrl = z.string().max(2048).refine(value => {
  try {
    const url=new URL(value);
    return url.protocol==='https:' || (!config.production && url.origin===new URL(config.apiUrl).origin && /^\/api\/v1\/media\/[0-9a-f-]{36}$/.test(url.pathname) && !url.search && !url.hash);
  } catch { return false; }
}, 'Image URLs must be absolute HTTPS URLs (use the existing GitHub Pages image URL or durable media hosting)');
const nullableNumber = z.number().finite().nonnegative().nullable();
const shared = {
  title: text,
  publication_status: z.enum(['draft','published']).default('draft'),
  sort_order: z.number().int().min(0).max(1000000).default(0),
};
export const propertySchema = z.object({
  ...shared,
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  location: text,
  display_location: text,
  property_type: z.enum(['house','apartment','land']),
  bedrooms: nullableNumber.refine(n => n === null || Number.isInteger(n), 'Bedrooms must be a whole number').default(null),
  bathrooms: nullableNumber.default(null),
  price_ghs: nullableNumber.default(null),
  price: z.string().trim().max(120).default('Price on request'),
  status: z.enum(['active','sold','reserved','unavailable','unknown']).default('unknown'),
  description: z.string().trim().min(1).max(10000),
  features: z.array(text).max(60).default([]),
  images: z.array(mediaUrl).min(1).max(30),
  image_alts: z.array(z.string().max(500)).max(30).default([]),
  area_sqft: nullableNumber.default(null),
  plot_dimensions: z.string().max(120).nullable().default(null),
  featured: z.boolean().default(false),
}).strict();
export const gallerySchema = z.object({
  ...shared,
  caption: z.string().trim().max(1000).default(''),
  category: z.string().trim().max(120).default(''),
  image_url: mediaUrl,
  alt: z.string().trim().min(1).max(500),
}).strict();
// Validate without trimming editorial content: approved whitespace and paragraphs
// must survive seed import and subsequent no-op saves byte-for-byte.
const editorialText=max=>z.string().min(1).max(max).refine(value=>value.trim().length>0,'This field cannot be blank.');
export const faqSchema=z.object({
  category:editorialText(200),
  question:editorialText(1000),
  answer:editorialText(30000),
  featured:z.boolean().default(false),
  publication_status:z.enum(['draft','published']).default('draft'),
  sort_order:z.number().int().min(0).max(1000000).default(0),
}).strict();
export function validateContent(kind, input) {
  const schema={properties:propertySchema,gallery:gallerySchema,faqs:faqSchema}[kind];
  if(!schema)throw new Error('Invalid content type');
  return schema.parse(input);
}
