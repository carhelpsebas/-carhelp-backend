// ============================================================
// CAR HELP S.A.S — server.js
// Servidor Express que expone la API para la app móvil/web
// Comando: node server.js
// ============================================================

import express          from 'express'
import cors             from 'cors'
import multer           from 'multer'
import dotenv           from 'dotenv'
import nodemailer       from 'nodemailer'
import { Readable }     from 'stream'
import {
  loginColaborador,
  getOrdenesDia,
  getOrdenes,
  completarEntrega,
  supabase,
} from './carhelp-entrega.js'

dotenv.config()

const app    = express()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }) // 10 MB max

app.use(cors({ origin: true, credentials: false }))
app.use(express.json())

// ------------------------------------------------------------
// Middleware: verificar sesión Supabase en cada request
// ------------------------------------------------------------
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '')
  if (!token) return res.status(401).json({ error: 'Sin autenticación' })

  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return res.status(401).json({ error: 'Sesión inválida' })

  req.user = user
  next()
}

// ============================================================
// RUTAS DE AUTENTICACIÓN
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' })

    const resultado = await loginColaborador(email, password)
    res.json({
      token:       resultado.session.access_token,
      colaborador: resultado.colaborador,
    })
  } catch (err) {
    res.status(401).json({ error: err.message })
  }
})

// POST /api/auth/logout
app.post('/api/auth/logout', requireAuth, async (req, res) => {
  await supabase.auth.signOut()
  res.json({ ok: true })
})

// ============================================================
// RUTAS DE ÓRDENES
// ============================================================

// GET /api/ordenes — órdenes del día del agente autenticado
app.get('/api/ordenes', requireAuth, async (req, res) => {
  try {
    // Obtener ID del colaborador desde su email
    const { data: colaborador } = await supabase
      .from('colaboradores')
      .select('id, rol')
      .eq('email', req.user.email)
      .single()

    let ordenes
    if (colaborador.rol === 'admin') {
      // Admin ve todas las órdenes
      ordenes = await getOrdenes({
        estado:     req.query.estado,
        fechaDesde: req.query.desde,
        fechaHasta: req.query.hasta,
      })
    } else {
      // Agente solo ve las del día
      ordenes = await getOrdenesDia(colaborador.id)
    }

    res.json(ordenes)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/ordenes/:id — detalle de una orden
app.get('/api/ordenes/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ordenes')
      .select(`
        *,
        clientes (*),
        vehiculos (*),
        colaboradores (nombre, email),
        entregas (*)
      `)
      .eq('id', req.params.id)
      .single()

    if (error) return res.status(404).json({ error: 'Orden no encontrada' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// RUTA PRINCIPAL: COMPLETAR ENTREGA
// Recibe multipart/form-data con fotos y documentos
// ============================================================

// POST /api/entregas
app.post('/api/entregas',
  requireAuth,
  upload.fields([
    { name: 'foto_frontal',    maxCount: 1 },
    { name: 'foto_trasera',    maxCount: 1 },
    { name: 'foto_lateral_izq',maxCount: 1 },
    { name: 'foto_lateral_der',maxCount: 1 },
    { name: 'foto_interior',   maxCount: 1 },
    { name: 'foto_tablero',    maxCount: 1 },
    { name: 'foto_combustible',maxCount: 1 },
    { name: 'foto_maletero',   maxCount: 1 },
    { name: 'doc_cedula',      maxCount: 1 },
    { name: 'doc_licencia',    maxCount: 1 },
    { name: 'doc_seguro',      maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const body = req.body
      const files = req.files || {}

      // Convertir buffers de Multer a Blob para Supabase Storage
      const toBlob = (fileArr) => {
        if (!fileArr?.[0]) return null
        const f = fileArr[0]
        return new Blob([f.buffer], { type: f.mimetype })
      }

      // Obtener colaborador actual
      const { data: colaborador } = await supabase
        .from('colaboradores')
        .select('id, nombre')
        .eq('email', req.user.email)
        .single()

      const resultado = await completarEntrega({
        ordenId:    body.orden_id,
        agenteId:   colaborador.id,
        vehiculoLabel: body.vehiculo_label,   // ej: 'Toyota Prado · ABC-123'

        clienteInfo: {
          nombre:        body.cliente_nombre,
          documento:     body.cliente_documento,
          licenciaNum:   body.licencia_num,
          licenciaCat:   body.licencia_cat,
          licenciaVence: body.licencia_vence,
          email:         body.cliente_email,
          telefono:      body.cliente_telefono,
        },

        kmSalida:          parseInt(body.km_salida),
        combustibleSalida: parseInt(body.combustible_pct),
        zonasDano:         JSON.parse(body.zonas_dano || '[]'),
        observaciones:     body.observaciones,

        fotos: {
          frontal:     toBlob(files.foto_frontal),
          trasera:     toBlob(files.foto_trasera),
          lateral_izq: toBlob(files.foto_lateral_izq),
          lateral_der: toBlob(files.foto_lateral_der),
          interior:    toBlob(files.foto_interior),
          tablero:     toBlob(files.foto_tablero),
          combustible: toBlob(files.foto_combustible),
          maletero:    toBlob(files.foto_maletero),
        },

        documentos: {
          cedula:   toBlob(files.doc_cedula),
          licencia: toBlob(files.doc_licencia),
          seguro:   toBlob(files.doc_seguro),
        },
      })

      res.json({
        ok:            true,
        ordenNumero:   resultado.ordenNumero,
        entregaId:     resultado.entregaId,
        correoEnviado: resultado.correoEnviado,
      })
    } catch (err) {
      console.error('[/api/entregas] Error:', err)
      res.status(500).json({ error: err.message })
    }
  }
)

// GET /api/entregas/:ordenId — obtener entrega de una orden
app.get('/api/entregas/:ordenId', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('entregas')
      .select('*')
      .eq('orden_id', req.params.ordenId)
      .single()

    if (error) return res.status(404).json({ error: 'Entrega no encontrada' })
    res.json(data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// RUTA: ENVÍO DE CORREO SIMPLE (reservas, tours, seguridad)
// ============================================================
const transporterSimple = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
})

// POST /api/enviar-correo
app.post('/api/enviar-correo', async (req, res) => {
  try {
    const { para, cc, asunto, cuerpo } = req.body
    if (!para || !asunto || !cuerpo) {
      return res.status(400).json({ error: 'Faltan campos: para, asunto, cuerpo' })
    }

    const htmlBody = cuerpo
      .split('\n')
      .map(line => line.trim() === '' ? '<br>' : `<p style="margin:0 0 6px;font-family:Arial,sans-serif;font-size:14px;color:#1a1a1a;white-space:pre-wrap">${line}</p>`)
      .join('')

    const info = await transporterSimple.sendMail({
      from: `"Car Help Rent a Car" <${process.env.GMAIL_USER}>`,
      to: para,
      cc: cc || undefined,
      subject: asunto,
      text: cuerpo,
      html: `<div style="max-width:600px;margin:0 auto;font-family:Arial,sans-serif">
        <div style="background:#0A0A0A;padding:20px;text-align:center">
          <div style="color:#C9A84C;font-family:Georgia,serif;font-size:22px;font-weight:bold;letter-spacing:2px">CAR HELP</div>
          <div style="color:#888;font-size:11px;letter-spacing:2px;margin-top:2px">RENT A CAR</div>
        </div>
        <div style="padding:24px;background:#fff">${htmlBody}</div>
        <div style="background:#0A0A0A;padding:16px 24px;text-align:center;color:#888;font-size:11px">
          Car Help S.A.S · NIT 901.697.903-5 · Pereira, Colombia<br>
          Cel. 310 743 6082 · reservascarhelp@gmail.com
        </div>
      </div>`,
    })

    res.json({ ok: true, messageId: info.messageId })
  } catch (err) {
    console.error('[/api/enviar-correo] Error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// RUTA: VEHÍCULOS
// ============================================================

// GET /api/vehiculos
app.get('/api/vehiculos', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('vehiculos')
    .select('*')
    .eq('activo', true)
    .order('marca')

  if (error) return res.status(500).json({ error: error.message })
  res.json(data)
})

// ============================================================
// RUTA: PANEL ADMIN — estadísticas rápidas
// ============================================================

// GET /api/dashboard
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const [activas, pendientes, completadas, hoy] = await Promise.all([
      supabase.from('ordenes').select('id', { count: 'exact' }).eq('estado', 'activo'),
      supabase.from('ordenes').select('id', { count: 'exact' }).eq('estado', 'pendiente'),
      supabase.from('ordenes').select('id', { count: 'exact' }).eq('estado', 'completado'),
      supabase.from('entregas').select('id', { count: 'exact' })
        .gte('created_at', new Date().toISOString().split('T')[0]),
    ])

    res.json({
      ordenesActivas:     activas.count     || 0,
      ordenesPendientes:  pendientes.count  || 0,
      ordenesCompletadas: completadas.count || 0,
      entregasHoy:        hoy.count         || 0,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`✓ Car Help API corriendo en puerto ${PORT}`)
})

export default app
