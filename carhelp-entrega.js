// ============================================================
// CAR HELP S.A.S — carhelp-entrega.js
// Integración completa: Supabase + Gmail (Nodemailer)
// Entorno: Node.js 18+ / Backend (Express o serverless)
// ============================================================

import { createClient } from '@supabase/supabase-js'
import nodemailer from 'nodemailer'
import { readFileSync } from 'fs'
import { join } from 'path'

// ------------------------------------------------------------
// CONFIGURACIÓN — usar variables de entorno (.env)
// ------------------------------------------------------------
const SUPABASE_URL     = process.env.SUPABASE_URL       // https://xxxx.supabase.co
const SUPABASE_KEY     = process.env.SUPABASE_ANON_KEY  // clave anon pública
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_KEY // clave service_role (solo backend)

const GMAIL_USER       = process.env.GMAIL_USER          // carhelp@gmail.com
const GMAIL_APP_PASS   = process.env.GMAIL_APP_PASSWORD  // contraseña de aplicación Google

// Cliente Supabase (usar service_role en backend para saltar RLS cuando sea necesario)
export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE)

// Cliente Gmail via Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASS,   // NO es la contraseña normal — ver GUIA_CONFIGURACION.md
  },
})

// ============================================================
// MÓDULO 1 — AUTENTICACIÓN DE COLABORADORES
// ============================================================

/**
 * Login de colaborador con email y contraseña
 * Usa Supabase Auth nativamente
 */
export async function loginColaborador(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error('Credenciales incorrectas: ' + error.message)

  // Obtener perfil del colaborador desde la tabla colaboradores
  const { data: perfil, error: perfilError } = await supabase
    .from('colaboradores')
    .select('id, nombre, rol, activo')
    .eq('email', email)
    .single()

  if (perfilError || !perfil) throw new Error('Colaborador no encontrado')
  if (!perfil.activo) throw new Error('Cuenta desactivada')

  return {
    session: data.session,
    colaborador: perfil,
  }
}

/**
 * Cerrar sesión
 */
export async function logoutColaborador() {
  await supabase.auth.signOut()
}

// ============================================================
// MÓDULO 2 — ÓRDENES DEL DÍA
// ============================================================

/**
 * Obtener órdenes pendientes del día para un agente
 */
export async function getOrdenesDia(agenteId) {
  const hoy = new Date()
  const inicio = new Date(hoy.setHours(0, 0, 0, 0)).toISOString()
  const fin    = new Date(hoy.setHours(23, 59, 59, 999)).toISOString()

  const { data, error } = await supabase
    .from('ordenes')
    .select(`
      id, numero, estado, fecha_salida, notas,
      clientes ( id, nombre, documento, email, telefono ),
      vehiculos ( id, marca, linea, placa, color )
    `)
    .eq('agente_id', agenteId)
    .gte('fecha_salida', inicio)
    .lte('fecha_salida', fin)
    .order('fecha_salida', { ascending: true })

  if (error) throw new Error('Error cargando órdenes: ' + error.message)
  return data
}

/**
 * Obtener todas las órdenes (admin) con filtros opcionales
 */
export async function getOrdenes({ estado, fechaDesde, fechaHasta } = {}) {
  let query = supabase
    .from('ordenes')
    .select(`
      id, numero, estado, fecha_salida, fecha_retorno, tarifa_diaria,
      clientes ( nombre, documento, email ),
      vehiculos ( marca, linea, placa ),
      colaboradores ( nombre )
    `)
    .order('fecha_salida', { ascending: false })

  if (estado)      query = query.eq('estado', estado)
  if (fechaDesde)  query = query.gte('fecha_salida', fechaDesde)
  if (fechaHasta)  query = query.lte('fecha_salida', fechaHasta)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  return data
}

// ============================================================
// MÓDULO 3 — SUBIDA DE ARCHIVOS A SUPABASE STORAGE
// ============================================================

/**
 * Subir una foto (File/Blob) a Supabase Storage
 * @param {File|Blob} archivo - archivo capturado desde cámara
 * @param {string} bucket     - 'entregas-fotos' | 'docs-clientes'
 * @param {string} ruta       - ej: 'orden-CH-2025-0042/frontal.jpg'
 * @returns {string} URL pública firmada (válida 1 año)
 */
export async function subirArchivo(archivo, bucket, ruta) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(ruta, archivo, {
      contentType: archivo.type || 'image/jpeg',
      upsert: true,
    })

  if (error) throw new Error('Error subiendo archivo: ' + error.message)

  // URL firmada con 1 año de validez (para acceso privado)
  const { data: urlData } = await supabase.storage
    .from(bucket)
    .createSignedUrl(ruta, 60 * 60 * 24 * 365)

  return urlData.signedUrl
}

/**
 * Subir las 8 fotos del vehículo en paralelo
 * @param {Object} fotos - { frontal: File, trasera: File, ... }
 * @param {string} ordenNumero - ej: 'CH-2025-0042'
 * @returns {Object} URLs de cada foto
 */
export async function subirFotosVehiculo(fotos, ordenNumero) {
  const angulos = ['frontal', 'trasera', 'lateral_izq', 'lateral_der',
                   'interior', 'tablero', 'combustible', 'maletero']

  const uploads = angulos.map(async (angulo) => {
    if (!fotos[angulo]) return [angulo, null]
    const ruta = `${ordenNumero}/${angulo}.jpg`
    const url  = await subirArchivo(fotos[angulo], 'entregas-fotos', ruta)
    return [angulo, url]
  })

  const resultados = await Promise.all(uploads)
  return Object.fromEntries(resultados)
}

/**
 * Subir documentos del cliente
 * @param {Object} docs   - { cedula: File, licencia: File, seguro?: File }
 * @param {string} clienteDoc - número de documento del cliente
 * @returns {Object} URLs de los documentos
 */
export async function subirDocumentosCliente(docs, clienteDoc) {
  const resultados = {}

  if (docs.cedula) {
    resultados.doc_cedula_url = await subirArchivo(
      docs.cedula, 'docs-clientes', `${clienteDoc}/cedula.jpg`
    )
  }
  if (docs.licencia) {
    resultados.doc_licencia_url = await subirArchivo(
      docs.licencia, 'docs-clientes', `${clienteDoc}/licencia.jpg`
    )
  }
  if (docs.seguro) {
    resultados.doc_seguro_url = await subirArchivo(
      docs.seguro, 'docs-clientes', `${clienteDoc}/seguro.jpg`
    )
  }

  return resultados
}

// ============================================================
// MÓDULO 4 — REGISTRAR ENTREGA COMPLETA
// ============================================================

/**
 * Guardar el registro completo de entrega en Supabase
 * Llama esta función al final del paso 5
 *
 * @param {Object} datos - todos los datos recolectados en el flujo
 * @returns {Object} entrega guardada + número de orden
 */
export async function registrarEntrega(datos) {
  const {
    ordenId,
    agenteId,
    clienteInfo,       // { nombre, documento, licenciaNum, licenciaCat, licenciaVence, email, telefono }
    vehiculoId,
    kmSalida,
    combustibleSalida, // 0-100
    zonasDano,         // [1, 6, 13, ...]
    observaciones,
    fotos,             // { frontal: File, trasera: File, ... }
    documentos,        // { cedula: File, licencia: File, seguro?: File }
  } = datos

  // 1. Actualizar o crear cliente
  const { data: cliente, error: clienteError } = await supabase
    .from('clientes')
    .upsert({
      documento:       clienteInfo.documento,
      nombre:          clienteInfo.nombre,
      licencia_num:    clienteInfo.licenciaNum,
      licencia_cat:    clienteInfo.licenciaCat,
      licencia_vence:  clienteInfo.licenciaVence,
      email:           clienteInfo.email,
      telefono:        clienteInfo.telefono,
    }, { onConflict: 'documento' })
    .select()
    .single()

  if (clienteError) throw new Error('Error guardando cliente: ' + clienteError.message)

  // 2. Subir fotos y documentos en paralelo
  const [fotosUrls, docsUrls] = await Promise.all([
    subirFotosVehiculo(fotos, `orden-${ordenId}`),
    subirDocumentosCliente(documentos, clienteInfo.documento),
  ])

  // 3. Registrar la entrega
  const { data: entrega, error: entregaError } = await supabase
    .from('entregas')
    .insert({
      orden_id:           ordenId,
      agente_id:          agenteId,
      km_salida:          kmSalida,
      combustible_salida: combustibleSalida,
      zonas_dano:         zonasDano,
      observaciones:      observaciones,
      fotos:              fotosUrls,
      ...docsUrls,
    })
    .select()
    .single()

  if (entregaError) throw new Error('Error registrando entrega: ' + entregaError.message)

  // 4. Actualizar estado de la orden a 'activo'
  await supabase
    .from('ordenes')
    .update({ estado: 'activo' })
    .eq('id', ordenId)

  // 5. Obtener número de orden para el correo
  const { data: orden } = await supabase
    .from('ordenes')
    .select('numero, fecha_retorno, tarifa_diaria')
    .eq('id', ordenId)
    .single()

  return { entrega, orden, fotosUrls }
}

// ============================================================
// MÓDULO 5 — CORREO AUTOMÁTICO AL CLIENTE (Gmail)
// ============================================================

/**
 * Generar HTML del inventario de daños para el correo
 */
function generarHtmlInventario(zonasDano, observaciones) {
  const ZONAS = {
    1:'Capó / cofre', 2:'Guardabarro del. izq.', 3:'Guardabarro del. der.',
    4:'Maletero / tapa', 5:'Techo', 6:'Puerta del. izq.',
    7:'Puerta tras. izq.', 8:'Estribo izq.', 9:'Puerta del. der.',
    10:'Puerta tras. der.', 11:'Estribo der.', 12:'Guardabarro tras. der.',
    13:'Parachoque delantero', 14:'Faro del. izq.', 15:'Faro del. der.',
    16:'Parachoque trasero', 17:'Calavera izq.', 18:'Calavera der.'
  }

  if (zonasDano.length === 0) {
    return '<p style="color:#2d6a2d;font-weight:500">✓ Sin daños preexistentes registrados</p>'
  }

  const filas = zonasDano.sort((a, b) => a - b).map(n => `
    <tr>
      <td style="padding:6px 12px;border-bottom:1px solid #f0e8cc;font-size:13px;color:#1a1a1a">
        <span style="display:inline-block;width:22px;height:22px;background:#C8A84B;color:#111;
          border-radius:50%;text-align:center;line-height:22px;font-size:11px;font-weight:600;
          margin-right:8px">${n}</span>${ZONAS[n] || 'Zona ' + n}
      </td>
    </tr>`).join('')

  return `
    <table style="width:100%;border-collapse:collapse;background:#fffdf5;border:1px solid #f0e8cc;border-radius:8px">
      ${filas}
    </table>
    ${observaciones ? `<p style="margin:12px 0 0;font-size:13px;color:#555"><strong>Observaciones:</strong> ${observaciones}</p>` : ''}
  `
}

/**
 * Enviar correo automático al cliente con resumen de entrega
 *
 * @param {Object} params
 * @param {string} params.clienteEmail
 * @param {string} params.clienteNombre
 * @param {string} params.ordenNumero       - CH-2025-0042
 * @param {string} params.vehiculo          - Toyota Prado · ABC-123
 * @param {string} params.fechaSalida
 * @param {string} params.fechaRetorno
 * @param {number} params.kmSalida
 * @param {number} params.combustibleSalida - 0-100
 * @param {number[]} params.zonasDano
 * @param {string} params.observaciones
 * @param {Object} params.fotosUrls
 * @param {string} params.agenteNombre
 */
export async function enviarCorreoEntrega(params) {
  const {
    clienteEmail, clienteNombre, ordenNumero, vehiculo,
    fechaSalida, fechaRetorno, kmSalida, combustibleSalida,
    zonasDano, observaciones, fotosUrls, agenteNombre
  } = params

  const combustibleLabel = combustibleSalida >= 88 ? 'Lleno (F)'
    : combustibleSalida >= 63 ? '¾ del tanque'
    : combustibleSalida >= 38 ? '½ del tanque'
    : combustibleSalida >= 13 ? '¼ del tanque'
    : 'Reserva (E)'

  const htmlInventario = generarHtmlInventario(zonasDano, observaciones)

  // Generar galería de fotos si existen
  const fotosHtml = fotosUrls ? Object.entries(fotosUrls)
    .filter(([, url]) => url)
    .map(([angulo, url]) => `
      <div style="display:inline-block;margin:6px;text-align:center">
        <img src="${url}" alt="${angulo}"
          style="width:160px;height:120px;object-fit:cover;border-radius:6px;border:1px solid #f0e8cc"/>
        <div style="font-size:11px;color:#888;margin-top:4px;text-transform:capitalize">${angulo.replace('_',' ')}</div>
      </div>`).join('')
    : ''

  const html = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f0;font-family:Arial,sans-serif">

  <div style="max-width:600px;margin:0 auto;background:#ffffff">

    <!-- HEADER -->
    <div style="background:#111111;padding:28px 32px;text-align:center">
      <div style="font-size:26px;font-weight:700;color:#C8A84B;letter-spacing:.1em">CAR HELP</div>
      <div style="font-size:12px;color:#888;letter-spacing:.15em;margin-top:4px">RENT A CAR · PEREIRA</div>
    </div>

    <!-- BIENVENIDA -->
    <div style="padding:28px 32px 0">
      <h1 style="font-size:18px;font-weight:600;color:#1a1a1a;margin:0 0 8px">
        Recibido del vehículo — ${ordenNumero}
      </h1>
      <p style="font-size:14px;color:#555;margin:0 0 24px;line-height:1.6">
        Estimado/a <strong>${clienteNombre}</strong>, a continuación encontrará el registro
        completo de la entrega de su vehículo. Guarde este correo como referencia del estado
        del vehículo al momento de recibirlo.
      </p>
    </div>

    <!-- DATOS GENERALES -->
    <div style="margin:0 32px;background:#fffdf5;border:1px solid #f0e8cc;border-radius:10px;padding:20px">
      <table style="width:100%;border-collapse:collapse">
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888;width:40%">Orden</td>
          <td style="padding:6px 0;font-size:13px;font-weight:600;color:#C8A84B">${ordenNumero}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Vehículo</td>
          <td style="padding:6px 0;font-size:13px;font-weight:500;color:#1a1a1a">${vehiculo}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Fecha salida</td>
          <td style="padding:6px 0;font-size:13px;color:#1a1a1a">${fechaSalida}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Retorno estimado</td>
          <td style="padding:6px 0;font-size:13px;color:#1a1a1a">${fechaRetorno || 'Por confirmar'}</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Km de salida</td>
          <td style="padding:6px 0;font-size:13px;color:#1a1a1a">${kmSalida?.toLocaleString('es-CO') || '–'} km</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Combustible</td>
          <td style="padding:6px 0;font-size:13px;color:#1a1a1a">${combustibleLabel} (${combustibleSalida}%)</td>
        </tr>
        <tr>
          <td style="padding:6px 0;font-size:13px;color:#888">Agente</td>
          <td style="padding:6px 0;font-size:13px;color:#1a1a1a">${agenteNombre}</td>
        </tr>
      </table>
    </div>

    <!-- INVENTARIO DE DAÑOS -->
    <div style="padding:24px 32px 0">
      <h2 style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 12px">
        Inventario de daños preexistentes
      </h2>
      ${htmlInventario}
    </div>

    <!-- FOTOS -->
    ${fotosHtml ? `
    <div style="padding:24px 32px 0">
      <h2 style="font-size:15px;font-weight:600;color:#1a1a1a;margin:0 0 12px">
        Registro fotográfico del vehículo
      </h2>
      <div style="text-align:center">${fotosHtml}</div>
    </div>` : ''}

    <!-- AVISO LEGAL -->
    <div style="margin:24px 32px;padding:16px;background:#f9f9f7;border-left:3px solid #C8A84B;border-radius:0 6px 6px 0">
      <p style="font-size:12px;color:#666;margin:0;line-height:1.6">
        Al recibir el vehículo, usted acepta los Términos y Condiciones del Contrato de Alquiler
        de Car Help S.A.S. Los daños no registrados en este documento serán responsabilidad del
        arrendatario al momento de la devolución. En caso de accidente o novedad, comuníquese
        inmediatamente al <strong style="color:#1a1a1a">Cel. 310 743 6082</strong>.
      </p>
    </div>

    <!-- FOOTER -->
    <div style="background:#111;padding:20px 32px;text-align:center">
      <div style="font-size:12px;color:#C8A84B;font-weight:500;margin-bottom:6px">CAR HELP S.A.S</div>
      <div style="font-size:11px;color:#555;line-height:1.7">
        NIT 901.697.903-5 · Ave Circunvalar # 8b-51 / oficina 304<br>
        Pereira, Risaralda · Cel. 310 743 6082<br>
        <a href="mailto:carhelp@gmail.com" style="color:#888">carhelp@gmail.com</a>
      </div>
    </div>

  </div>
</body>
</html>`

  const info = await transporter.sendMail({
    from:    `"Car Help Rent a Car" <${GMAIL_USER}>`,
    to:      clienteEmail,
    cc:      GMAIL_USER,           // copia a Car Help
    subject: `✓ Recibido del vehículo — ${ordenNumero} · ${vehiculo}`,
    html,
    // Texto plano como fallback
    text: `Car Help S.A.S — Orden ${ordenNumero}\nVehículo: ${vehiculo}\nKm salida: ${kmSalida}\nCombustible: ${combustibleLabel}\nDaños preexistentes: ${zonasDano.length > 0 ? zonasDano.join(', ') : 'Ninguno'}\nContacto: 310 743 6082`,
  })

  // Marcar correo como enviado en la BD
  await supabase
    .from('entregas')
    .update({
      correo_enviado:    true,
      correo_enviado_at: new Date().toISOString(),
    })
    .eq('orden_id', params.ordenId)

  return info.messageId
}

// ============================================================
// MÓDULO 6 — FLUJO COMPLETO (llamada única desde la app)
// ============================================================

/**
 * Ejecutar el flujo completo de entrega:
 * 1. Guardar cliente
 * 2. Subir fotos y documentos
 * 3. Registrar entrega en BD
 * 4. Enviar correo al cliente
 *
 * @param {Object} datosEntrega - todos los datos del flujo de 5 pasos
 * @returns {{ ordenNumero, entregaId, correoEnviado }}
 */
export async function completarEntrega(datosEntrega) {
  try {
    // Paso 1-4: guardar en BD y subir archivos
    const { entrega, orden, fotosUrls } = await registrarEntrega(datosEntrega)

    // Obtener nombre del agente
    const { data: agente } = await supabase
      .from('colaboradores')
      .select('nombre')
      .eq('id', datosEntrega.agenteId)
      .single()

    // Paso 5: enviar correo
    await enviarCorreoEntrega({
      ordenId:           datosEntrega.ordenId,
      clienteEmail:      datosEntrega.clienteInfo.email,
      clienteNombre:     datosEntrega.clienteInfo.nombre,
      ordenNumero:       orden.numero,
      vehiculo:          datosEntrega.vehiculoLabel,   // ej: 'Toyota Prado · ABC-123'
      fechaSalida:       new Date().toLocaleDateString('es-CO', { dateStyle: 'long' }),
      fechaRetorno:      orden.fecha_retorno
        ? new Date(orden.fecha_retorno).toLocaleDateString('es-CO', { dateStyle: 'long' })
        : null,
      kmSalida:          datosEntrega.kmSalida,
      combustibleSalida: datosEntrega.combustibleSalida,
      zonasDano:         datosEntrega.zonasDano,
      observaciones:     datosEntrega.observaciones,
      fotosUrls,
      agenteNombre:      agente?.nombre || 'Agente Car Help',
    })

    return {
      ordenNumero:   orden.numero,
      entregaId:     entrega.id,
      correoEnviado: true,
    }
  } catch (error) {
    console.error('[Car Help] Error en completarEntrega:', error)
    throw error
  }
}

export default { loginColaborador, getOrdenesDia, completarEntrega }
