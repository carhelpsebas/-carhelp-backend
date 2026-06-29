-- ============================================================
-- CAR HELP S.A.S — Esquema Supabase
-- Ejecutar en: Supabase Dashboard > SQL Editor
-- ============================================================

-- Extensión para UUIDs
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ------------------------------------------------------------
-- TABLA: colaboradores (usuarios internos de Car Help)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS colaboradores (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre        TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  rol           TEXT NOT NULL DEFAULT 'agente',   -- 'agente' | 'admin'
  activo        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLA: vehiculos (flota de Car Help)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vehiculos (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  marca         TEXT NOT NULL,
  linea         TEXT NOT NULL,
  placa         TEXT UNIQUE NOT NULL,
  color         TEXT,
  anio          INT,
  chasis        TEXT,
  soat_vence    DATE,
  activo        BOOLEAN DEFAULT TRUE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLA: clientes
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clientes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre          TEXT NOT NULL,
  documento       TEXT UNIQUE NOT NULL,
  tipo_doc        TEXT DEFAULT 'CC',              -- CC | CE | PAS
  licencia_num    TEXT,
  licencia_cat    TEXT,
  licencia_vence  DATE,
  telefono        TEXT,
  email           TEXT,
  direccion       TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLA: ordenes (orden de alquiler)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ordenes (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  numero          TEXT UNIQUE NOT NULL,           -- CH-2025-0042
  cliente_id      UUID REFERENCES clientes(id),
  vehiculo_id     UUID REFERENCES vehiculos(id),
  agente_id       UUID REFERENCES colaboradores(id),
  fecha_salida    TIMESTAMPTZ,
  fecha_retorno   TIMESTAMPTZ,
  tarifa_diaria   NUMERIC(12,2),
  deposito        NUMERIC(12,2),
  km_incluidos    INT DEFAULT 200,
  km_extra_valor  NUMERIC(10,2),
  estado          TEXT DEFAULT 'pendiente',       -- pendiente | activo | completado | cancelado
  notas           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLA: entregas (registro del flujo de entrega)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entregas (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  orden_id            UUID REFERENCES ordenes(id) ON DELETE CASCADE,

  -- Kilometraje y combustible
  km_salida           INT,
  combustible_salida  INT,                         -- 0-100 (porcentaje)

  -- Inventario de daños (array de números de zona, ej: [1, 6, 13])
  zonas_dano          INT[] DEFAULT '{}',
  observaciones       TEXT,

  -- Documentos escaneados (URLs en Supabase Storage)
  doc_cedula_url      TEXT,
  doc_licencia_url    TEXT,
  doc_seguro_url      TEXT,

  -- Fotos del vehículo (objeto JSON con URLs por ángulo)
  fotos               JSONB DEFAULT '{}',
  -- Estructura esperada:
  -- {
  --   "frontal": "https://...",
  --   "trasera": "https://...",
  --   "lateral_izq": "https://...",
  --   "lateral_der": "https://...",
  --   "interior": "https://...",
  --   "tablero": "https://...",
  --   "combustible": "https://...",
  --   "maletero": "https://..."
  -- }

  -- Metadatos
  agente_id           UUID REFERENCES colaboradores(id),
  correo_enviado      BOOLEAN DEFAULT FALSE,
  correo_enviado_at   TIMESTAMPTZ,
  firma_cliente_url   TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- TABLA: devoluciones (cuando el cliente retorna el vehículo)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS devoluciones (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  orden_id              UUID REFERENCES ordenes(id) ON DELETE CASCADE,
  km_llegada            INT,
  combustible_llegada   INT,
  zonas_dano_nuevas     INT[] DEFAULT '{}',
  observaciones         TEXT,
  fotos                 JSONB DEFAULT '{}',
  cobro_adicional       NUMERIC(12,2) DEFAULT 0,
  detalle_cobro         TEXT,
  agente_id             UUID REFERENCES colaboradores(id),
  created_at            TIMESTAMPTZ DEFAULT NOW()
);

-- ------------------------------------------------------------
-- ÍNDICES para consultas frecuentes
-- ------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_ordenes_cliente   ON ordenes(cliente_id);
CREATE INDEX IF NOT EXISTS idx_ordenes_estado    ON ordenes(estado);
CREATE INDEX IF NOT EXISTS idx_ordenes_agente    ON ordenes(agente_id);
CREATE INDEX IF NOT EXISTS idx_entregas_orden    ON entregas(orden_id);
CREATE INDEX IF NOT EXISTS idx_devoluciones_ord  ON devoluciones(orden_id);

-- ------------------------------------------------------------
-- FUNCIÓN: generar número de orden automático CH-AÑO-XXXX
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION generar_numero_orden()
RETURNS TRIGGER AS $$
DECLARE
  anio    TEXT := TO_CHAR(NOW(), 'YYYY');
  secuencia INT;
BEGIN
  SELECT COUNT(*) + 1 INTO secuencia
  FROM ordenes
  WHERE EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());

  NEW.numero := 'CH-' || anio || '-' || LPAD(secuencia::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_numero_orden
  BEFORE INSERT ON ordenes
  FOR EACH ROW
  WHEN (NEW.numero IS NULL OR NEW.numero = '')
  EXECUTE FUNCTION generar_numero_orden();

-- ------------------------------------------------------------
-- RLS (Row Level Security) — activar por tabla
-- ------------------------------------------------------------
ALTER TABLE colaboradores  ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehiculos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ordenes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE entregas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE devoluciones   ENABLE ROW LEVEL SECURITY;

-- Política: solo usuarios autenticados acceden a sus datos
CREATE POLICY "Colaboradores autenticados" ON colaboradores
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Solo autenticados - vehiculos" ON vehiculos
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Solo autenticados - clientes" ON clientes
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Solo autenticados - ordenes" ON ordenes
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Solo autenticados - entregas" ON entregas
  FOR ALL USING (auth.role() = 'authenticated');

CREATE POLICY "Solo autenticados - devoluciones" ON devoluciones
  FOR ALL USING (auth.role() = 'authenticated');

-- ------------------------------------------------------------
-- STORAGE: crear buckets para archivos
-- ------------------------------------------------------------
-- Ejecutar también en Supabase Dashboard > Storage:
-- 1. Bucket: "entregas-fotos"     → privado
-- 2. Bucket: "docs-clientes"      → privado
-- 3. Bucket: "firmas"             → privado

-- O via SQL:
INSERT INTO storage.buckets (id, name, public)
VALUES
  ('entregas-fotos', 'entregas-fotos', false),
  ('docs-clientes',  'docs-clientes',  false),
  ('firmas',         'firmas',         false)
ON CONFLICT DO NOTHING;

-- Política de storage: solo autenticados pueden subir
CREATE POLICY "Upload autenticado - fotos" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id IN ('entregas-fotos', 'docs-clientes', 'firmas')
    AND auth.role() = 'authenticated'
  );

CREATE POLICY "Lectura autenticada" ON storage.objects
  FOR SELECT USING (
    bucket_id IN ('entregas-fotos', 'docs-clientes', 'firmas')
    AND auth.role() = 'authenticated'
  );

-- ------------------------------------------------------------
-- DATOS DE PRUEBA (opcional, comentar en producción)
-- ------------------------------------------------------------
INSERT INTO colaboradores (nombre, email, rol) VALUES
  ('Juan Pérez',    'juan.perez@carhelp.co',  'agente'),
  ('María López',   'maria.lopez@carhelp.co', 'agente'),
  ('Admin Car Help','admin@carhelp.co',        'admin')
ON CONFLICT DO NOTHING;

INSERT INTO vehiculos (marca, linea, placa, color, anio) VALUES
  ('Toyota',  'Prado',   'ABC-123', 'Blanco',  2022),
  ('Renault', 'Duster',  'XYZ-456', 'Gris',    2023),
  ('Toyota',  'Land Cruiser', 'DEF-789', 'Negro', 2021)
ON CONFLICT DO NOTHING;
