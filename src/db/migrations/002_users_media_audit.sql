ALTER TABLE staff ADD COLUMN name text NOT NULL DEFAULT '';
ALTER TABLE staff ADD COLUMN role text NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin'));
ALTER TABLE staff ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE staff ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- Preserve the original owner account; later accounts remain content admins.
UPDATE staff SET role='super_admin'
WHERE id=(SELECT id FROM staff ORDER BY created_at,id LIMIT 1)
AND NOT EXISTS (SELECT 1 FROM staff WHERE role='super_admin');

CREATE TABLE media (
  id uuid PRIMARY KEY,
  content_type text NOT NULL CHECK (content_type='image/webp'),
  bytes bytea NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  uploaded_by uuid REFERENCES staff(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id uuid REFERENCES staff(id) ON DELETE SET NULL,
  actor_email text,
  action text NOT NULL,
  level text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warning','error')),
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_recent ON audit_logs(created_at DESC,id DESC);
CREATE INDEX audit_logs_level ON audit_logs(level,created_at DESC);
