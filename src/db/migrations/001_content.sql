CREATE TABLE IF NOT EXISTS staff (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS properties (
  id text PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  publication_status text NOT NULL CHECK (publication_status IN ('draft','published')),
  sort_order integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS gallery (
  id text PRIMARY KEY,
  publication_status text NOT NULL CHECK (publication_status IN ('draft','published')),
  sort_order integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS properties_public_order ON properties(publication_status, sort_order, id);
CREATE INDEX IF NOT EXISTS gallery_public_order ON gallery(publication_status, sort_order, id);
CREATE TABLE IF NOT EXISTS sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire ON sessions(expire);
