CREATE TABLE faqs (
  id text PRIMARY KEY CHECK (id ~ '^faq-[A-Za-z0-9_-]+$'),
  publication_status text NOT NULL CHECK (publication_status IN ('draft','published')),
  sort_order integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX faqs_public_order ON faqs(publication_status,sort_order,id);
-- Import history is independent of live FAQ rows so deletion never triggers a reseed.
CREATE TABLE faq_seed_records (
  seed_name text NOT NULL,
  record_id text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(seed_name,record_id)
);
