PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE COLLATE NOCASE,
  activa INTEGER NOT NULL DEFAULT 1 CHECK (activa IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'ADMIN' CHECK (role IN ('ADMIN', 'OPERATOR')),
  area_id INTEGER REFERENCES areas(id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS login_attempts (
  ip_hash TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL,
  reset_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS sequences (
  year INTEGER PRIMARY KEY,
  last_value INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS tramites (
  id INTEGER PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  tipo_documento TEXT NOT NULL,
  documento TEXT NOT NULL,
  correo TEXT NOT NULL,
  telefono TEXT NOT NULL,
  tipo TEXT NOT NULL,
  area TEXT NOT NULL,
  asunto TEXT NOT NULL,
  descripcion TEXT NOT NULL,
  stored_filename TEXT,
  original_filename TEXT,
  mime_type TEXT,
  file_size INTEGER,
  estado TEXT NOT NULL DEFAULT 'Recibido' CHECK (estado IN ('Recibido', 'En revisión', 'Atendido', 'Observado')),
  workflow_status TEXT NOT NULL DEFAULT 'Recibido por Mesa de Partes',
  current_area_id INTEGER REFERENCES areas(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS historial (
  id INTEGER PRIMARY KEY,
  tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
  estado TEXT NOT NULL,
  nota TEXT NOT NULL DEFAULT '',
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS derivaciones (
  id INTEGER PRIMARY KEY,
  tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
  origin_area_id INTEGER NOT NULL REFERENCES areas(id),
  destination_area_id INTEGER NOT NULL REFERENCES areas(id),
  sent_by INTEGER NOT NULL REFERENCES users(id),
  received_by INTEGER REFERENCES users(id),
  comentario TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (visibility IN ('INTERNAL', 'PUBLIC')),
  sent_at TEXT NOT NULL,
  received_at TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS comentarios (
  id INTEGER PRIMARY KEY,
  tramite_id INTEGER NOT NULL REFERENCES tramites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  mensaje TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('INTERNAL', 'PUBLIC')),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_users_area ON users(area_id, active);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_tramites_documento ON tramites(documento);
CREATE INDEX IF NOT EXISTS idx_tramites_estado ON tramites(estado);
CREATE INDEX IF NOT EXISTS idx_tramites_workflow ON tramites(workflow_status);
CREATE INDEX IF NOT EXISTS idx_tramites_area ON tramites(current_area_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tramites_created_at ON tramites(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historial_tramite ON historial(tramite_id, created_at);
CREATE INDEX IF NOT EXISTS idx_derivaciones_tramite ON derivaciones(tramite_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_derivaciones_origin ON derivaciones(origin_area_id, tramite_id);
CREATE INDEX IF NOT EXISTS idx_comentarios_tramite ON comentarios(tramite_id, created_at);
