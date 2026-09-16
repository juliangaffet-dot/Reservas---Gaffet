const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '14mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── BASE DE DATOS ────────────────────────────────────────────────────────────
const fs = require('fs');
const DB_DIR = fs.existsSync('/data') ? '/data' : __dirname;
const db = new Database(path.join(DB_DIR, 'asistencia.db'));
console.log(`📦 Base de datos en: ${path.join(DB_DIR, 'asistencia.db')}`);

db.exec(`
  CREATE TABLE IF NOT EXISTS turnos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    email TEXT,
    telefono TEXT,
    acompanante TEXT,
    profesional TEXT NOT NULL,
    fecha TEXT NOT NULL,
    hora TEXT NOT NULL,
    estado TEXT DEFAULT 'pendiente',
    paciente_id INTEGER,
    cancel_token TEXT,
    creado_en TEXT DEFAULT (datetime('now','-3 hours'))
  );

  CREATE TABLE IF NOT EXISTS pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    obra_social TEXT,
    plan TEXT,
    sesiones_total INTEGER NOT NULL DEFAULT 10,
    sesiones_usadas INTEGER NOT NULL DEFAULT 0,
    profesional TEXT NOT NULL DEFAULT 'julian',
    email TEXT,
    telefono TEXT,
    sin_completar INTEGER NOT NULL DEFAULT 1,
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','-3 hours'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS planilla_pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    obra_social TEXT DEFAULT '',
    sesiones_autorizadas INTEGER DEFAULT 10,
    telefono TEXT DEFAULT '',
    observaciones TEXT DEFAULT '',
    profesional TEXT NOT NULL DEFAULT 'julian',
    activo INTEGER NOT NULL DEFAULT 1,
    creado_en TEXT DEFAULT (datetime('now','-3 hours'))
  );

  CREATE TABLE IF NOT EXISTS planilla_sesiones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL,
    mes TEXT NOT NULL,          -- formato 'YYYY-MM'
    col INTEGER NOT NULL,       -- posición de la celda 0-9
    fecha TEXT DEFAULT '',      -- texto libre ej '15-Jul'
    pagada INTEGER NOT NULL DEFAULT 0,
    UNIQUE(paciente_id, mes, col)
  );
`);

// Migraciones suaves
try { db.exec(`ALTER TABLE planilla_pacientes ADD COLUMN mes TEXT`); } catch(e) {}
// Todos los pacientes de planilla existentes (sin mes) quedan en julio del año actual
try {
  const anio = new Date(new Date().getTime() - 3*60*60*1000).getUTCFullYear();
  db.prepare(`UPDATE planilla_pacientes SET mes = ? WHERE mes IS NULL OR mes = ''`).run(anio + '-07');
  // Sus sesiones también se mueven a julio (por si se cargaron parado en otro mes)
  db.prepare(`UPDATE OR IGNORE planilla_sesiones SET mes = ? WHERE paciente_id IN (SELECT id FROM planilla_pacientes WHERE mes = ?)`).run(anio + '-07', anio + '-07');
} catch(e) { console.error('Migración mes planilla:', e.message); }
try { db.exec(`ALTER TABLE pacientes ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN telefono TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN sin_completar INTEGER NOT NULL DEFAULT 1`); } catch(e) {}
try { db.exec(`ALTER TABLE turnos ADD COLUMN cancel_token TEXT`); } catch(e) {}

// ─── WEB EDITABLE (landing administrable) ─────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS web_config (
    clave TEXT PRIMARY KEY,
    valor TEXT
  );
  CREATE TABLE IF NOT EXISTS web_media (
    clave TEXT PRIMARY KEY,       -- 'logo' | 'hero' | 'nosotros'
    mime TEXT,
    datos TEXT,                   -- base64 (sin el prefijo data:)
    actualizado TEXT DEFAULT (datetime('now','-3 hours'))
  );
`);

// Config por defecto (se usa si el admin todavía no guardó nada)
const DEFAULT_WEB = {
  color: "#8a8c52",
  hero: {
    tag: "Salta \u00b7 Kinesiolog\u00eda & Fisioterapia",
    titulo: "Volv\u00e9 a moverte",
    destacado: "sin l\u00edmites",
    sub: "Tratamientos a medida, con experiencia cl\u00ednica y un trato cercano."
  },
  servicios: {
    visible: true,
    titulo: "Servicios pensados para vos",
    sub: "Cada tratamiento se dise\u00f1a a partir de una evaluaci\u00f3n y de tus objetivos.",
    items: [
      { icono: "\ud83e\uddb4", nombre: "Kinesiolog\u00eda y Fisioterapia", desc: "Evaluaci\u00f3n y tratamiento del dolor y las lesiones para devolverte la funcionalidad." },
      { icono: "\ud83c\udfc3", nombre: "Readaptaci\u00f3n F\u00edsica", desc: "El puente entre la lesi\u00f3n y tu vuelta a la actividad, con progresi\u00f3n segura." },
      { icono: "\ud83d\udcaa", nombre: "Rehabilitaci\u00f3n Deportiva", desc: "Volv\u00e9 a competir con confianza, con un plan orientado a tu deporte." },
      { icono: "\ud83d\udccb", nombre: "Planes personalizados", desc: "Rutinas a medida que segu\u00eds en el centro, en casa o el gimnasio, con seguimiento." }
    ]
  },
  nosotros: {
    visible: true,
    titulo: "Recuperaci\u00f3n con acompa\u00f1amiento real",
    p1: "Somos un equipo de kinesi\u00f3logos especializados en rehabilitaci\u00f3n f\u00edsica y readaptaci\u00f3n deportiva. Combinamos experiencia cl\u00ednica con un trato cercano.",
    p2: "Dise\u00f1amos cada tratamiento a medida y te acompa\u00f1amos en cada etapa del proceso."
  },
  equipo: {
    visible: true,
    titulo: "Profesionales matriculados",
    mensajeWa: "Hola {nombre}! Te escribo desde la web de Kine House. Quer\u00eda hacerte una consulta.",
    items: [
      { iniciales: "JG", nombre: "Lic. Juli\u00e1n Gaffet", rol: "Kinesi\u00f3logo", mp: "M.P. 1321", tel: "" },
      { iniciales: "MA", nombre: "Lic. Mauro Ayub", rol: "Kinesi\u00f3logo", mp: "M.P. 1263", tel: "" },
      { iniciales: "EV", nombre: "Lic. Esteban Videla", rol: "Kinesi\u00f3logo", mp: "M.P. 1337", tel: "" }
    ]
  },
  ubicacion: {
    visible: true,
    direccion: "Cmte. Piedrabuena 820",
    ciudad: "Salta, Argentina",
    maps: "https://maps.app.goo.gl/aRSoRvJjGjk8eqDq5"
  },
  cta: {
    titulo: "\u00bfListo para empezar?",
    sub: "Reserv\u00e1 tu sesi\u00f3n online en pocos pasos. Eleg\u00ed profesional, d\u00eda y horario."
  }
};

function getWebConfig() {
  const row = db.prepare("SELECT valor FROM web_config WHERE clave = 'landing'").get();
  if (!row) return JSON.parse(JSON.stringify(DEFAULT_WEB));
  try {
    const saved = JSON.parse(row.valor);
    // merge superficial con defaults por si se agregan campos nuevos
    return Object.assign(JSON.parse(JSON.stringify(DEFAULT_WEB)), saved);
  } catch(e) { return JSON.parse(JSON.stringify(DEFAULT_WEB)); }
}

function setWebConfig(cfg) {
  db.prepare("INSERT INTO web_config (clave, valor) VALUES ('landing', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor")
    .run(JSON.stringify(cfg));
}

function hasMedia(clave) {
  return !!db.prepare("SELECT 1 FROM web_media WHERE clave = ?").get(clave);
}

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CLIENT_ID      = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const REFRESH_TOKEN  = process.env.GOOGLE_REFRESH_TOKEN;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'kinehouse2025';
const BASE_URL       = process.env.BASE_URL || 'https://reservas-kinehouse.up.railway.app';

const PROFESIONALES = {
  julian:  { nombre: 'Lic. Julián Gaffet',  mp: '1321', calendarId: 'primary' },
  mauro:   { nombre: 'Lic. Mauro Ayub',     mp: '1263', calendarId: 'mauroayub@gmail.com' },
  esteban: { nombre: 'Lic. Esteban Videla', mp: '1337', calendarId: 'tebyvidela@gmail.com' }
};

const PALABRAS_BLOQUEO = ['bloqueado', 'no disponible', 'feriado', 'cerrado', 'ocupado', 'no atiende'];

// ─── OAUTH ────────────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// ─── UTILS ────────────────────────────────────────────────────────────────────
function obtenerOCrearPaciente(nombre, profesional, email, telefono) {
  const existente = db.prepare(`
    SELECT id FROM pacientes WHERE LOWER(nombre) = LOWER(?) AND profesional = ? AND activo = 1 LIMIT 1
  `).get(nombre, profesional);
  if (existente) {
    if (email || telefono) {
      db.prepare(`UPDATE pacientes SET email = COALESCE(NULLIF(email,''), ?), telefono = COALESCE(NULLIF(telefono,''), ?) WHERE id = ?`).run(email || '', telefono || '', existente.id);
    }
    return existente.id;
  }
  const result = db.prepare(`
    INSERT INTO pacientes (nombre, obra_social, plan, sesiones_total, sesiones_usadas, profesional, email, telefono, sin_completar)
    VALUES (?, '', '', 10, 0, ?, ?, ?, 1)
  `).run(nombre, profesional, email || '', telefono || '');
  return result.lastInsertRowid;
}

function getHoraArgentina() {
  const arg = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  return { hora: arg.getUTCHours(), minuto: arg.getUTCMinutes() };
}
function getFechaArgentina() {
  const arg = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  return arg.toISOString().substring(0, 10);
}

function formatFechaDisplay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const days = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const months = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  return days[d.getDay()] + ' ' + d.getDate() + ' de ' + months[d.getMonth()];
}

// ─── ENVIAR EMAIL VIA GMAIL API ───────────────────────────────────────────────
async function enviarEmailConfirmacion({ nombre, email, fecha, hora, profesional, cancelToken, acompanante }) {
  try {
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
    const prof = PROFESIONALES[profesional] || PROFESIONALES.julian;
    const fechaDisplay = formatFechaDisplay(fecha);
    const cancelUrl = `${BASE_URL}/cancelar?token=${cancelToken}`;

    const htmlBody = `
<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:30px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <!-- Header -->
        <tr><td style="background:#2D4A3E;padding:28px 32px;">
          <div style="font-size:22px;font-weight:700;color:white;letter-spacing:-0.5px;">Kine House</div>
          <div style="font-size:13px;color:#9FE1CB;margin-top:4px;">Centro de Kinesiología y Fisioterapia</div>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          <p style="font-size:16px;color:#1C1C1E;margin:0 0 8px;">Hola <strong>${nombre}</strong> 👋</p>
          <p style="font-size:15px;color:#6b6b5a;margin:0 0 24px;">Tu turno quedó confirmado. Acá están los detalles:</p>

          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f7f4;border-radius:10px;padding:20px;margin-bottom:24px;">
            <tr><td style="padding:6px 0;">
              <span style="font-size:13px;color:#6b6b5a;display:block;">📅 Fecha</span>
              <span style="font-size:15px;font-weight:600;color:#1C1C1E;text-transform:capitalize;">${fechaDisplay}</span>
            </td></tr>
            <tr><td style="padding:6px 0;border-top:1px solid #d4ead9;">
              <span style="font-size:13px;color:#6b6b5a;display:block;">🕐 Horario</span>
              <span style="font-size:15px;font-weight:600;color:#1C1C1E;">${hora} hs</span>
            </td></tr>
            <tr><td style="padding:6px 0;border-top:1px solid #d4ead9;">
              <span style="font-size:13px;color:#6b6b5a;display:block;">👨‍⚕️ Profesional</span>
              <span style="font-size:15px;font-weight:600;color:#1C1C1E;">${prof.nombre}</span>
            </td></tr>
            ${acompanante ? `<tr><td style="padding:6px 0;border-top:1px solid #d4ead9;">
              <span style="font-size:13px;color:#6b6b5a;display:block;">👥 Acompañante</span>
              <span style="font-size:15px;font-weight:600;color:#1C1C1E;">${acompanante}</span>
            </td></tr>` : ''}
            <tr><td style="padding:6px 0;border-top:1px solid #d4ead9;">
              <span style="font-size:13px;color:#6b6b5a;display:block;">📍 Dirección</span>
              <span style="font-size:15px;font-weight:600;color:#1C1C1E;">Cmte. Piedrabuena 820, Salta</span>
            </td></tr>
          </table>

          <p style="font-size:14px;color:#6b6b5a;margin:0 0 20px;">Si necesitás cancelar el turno, hacé clic en el botón de abajo. Por favor cancelá con al menos 2 horas de anticipación.</p>

          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${cancelUrl}" style="display:inline-block;background:#A32D2D;color:white;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:14px;font-weight:600;">Cancelar turno</a>
            </td></tr>
          </table>
        </td></tr>
        <!-- Footer -->
        <tr><td style="background:#f8f8f8;padding:16px 32px;border-top:1px solid #eee;">
          <p style="font-size:12px;color:#aaa;margin:0;text-align:center;">Kine House · Cmte. Piedrabuena 820, Salta · Este email fue enviado automáticamente</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const subject = `✅ Turno confirmado — ${fechaDisplay} ${hora} hs`;
    const message = [
      `From: Kine House <juliangaffet@gmail.com>`,
      `To: ${email}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      ``,
      htmlBody
    ].join('\n');

    const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    await gmail.users.messages.send({ userId: 'me', resource: { raw: encoded } });
    console.log(`📧 Email enviado a ${email}`);
  } catch(err) {
    console.error('Error enviando email:', err.message);
    // No fallar la reserva si el email falla
  }
}

// ─── JOB AUTOMÁTICO 21hs ─────────────────────────────────────────────────────
function marcarAsistenciaDelDia() {
  const hoy = getFechaArgentina();
  const pendientes = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND estado = 'pendiente'`).all(hoy);
  const marcar = db.transaction((turno) => {
    db.prepare(`UPDATE turnos SET estado = 'asistio' WHERE id = ?`).run(turno.id);
    if (turno.paciente_id) {
      db.prepare(`UPDATE pacientes SET sesiones_usadas = sesiones_usadas + 1 WHERE id = ? AND sesiones_usadas < sesiones_total`).run(turno.paciente_id);
    }
  });
  pendientes.forEach(t => marcar(t));
  console.log(`✅ Asistencia automática: ${pendientes.length} turno(s) marcados para ${hoy}`);
}

setInterval(() => {
  const { hora, minuto } = getHoraArgentina();
  if (hora === 21 && minuto === 0) marcarAsistenciaDelDia();
}, 60 * 1000);

// ─── AUTH GOOGLE ──────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.send'] });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  console.log('\n✅ REFRESH TOKEN:\n', tokens.refresh_token);
  res.send('<h2>✅ Autorización exitosa!</h2>');
});

// ─── CANCELAR TURNO ───────────────────────────────────────────────────────────
app.get('/cancelar', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.send(paginaCancelacion('error', 'Link inválido.'));

  const turno = db.prepare(`SELECT * FROM turnos WHERE cancel_token = ?`).get(token);
  if (!turno) return res.send(paginaCancelacion('error', 'Este link ya fue usado o no es válido.'));
  if (turno.estado === 'cancelado') return res.send(paginaCancelacion('ya_cancelado', '', turno));
  if (turno.estado === 'asistio') return res.send(paginaCancelacion('error', 'Este turno ya fue marcado como asistido y no puede cancelarse.'));

  // Verificar que no sea menos de 2 horas antes
  const slotTime = new Date(turno.fecha + 'T' + turno.hora + ':00-03:00');
  if (slotTime - new Date() < 30 * 60 * 1000) {
    return res.send(paginaCancelacion('error', 'No se puede cancelar con menos de 30 minutos de anticipación. Comunicate directamente con el centro.'));
  }

  // Mostrar página de confirmación de cancelación
  res.send(paginaConfirmarCancelacion(token, turno));
});

app.post('/cancelar', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ ok: false, error: 'Token inválido' });

  const turno = db.prepare(`SELECT * FROM turnos WHERE cancel_token = ?`).get(token);
  if (!turno) return res.status(404).json({ ok: false, error: 'Turno no encontrado' });
  if (turno.estado === 'cancelado') return res.json({ ok: true, mensaje: 'Ya estaba cancelado' });

  try {
    // Cancelar en Google Calendar
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const prof = PROFESIONALES[turno.profesional] || PROFESIONALES.julian;

    // Buscar el evento en el calendario
    const fechaStr = turno.fecha;
    const response = await calendar.events.list({
      calendarId: prof.calendarId,
      timeMin: `${fechaStr}T00:00:00-03:00`,
      timeMax: `${fechaStr}T23:59:59-03:00`,
      singleEvents: true,
    });

    const eventos = response.data.items || [];
    const evento = eventos.find(ev => {
      const horaEv = ev.start?.dateTime?.substring(11, 16);
      const titulo = ev.summary || '';
      return horaEv === turno.hora && titulo.toLowerCase().includes(turno.nombre.toLowerCase());
    });

    if (evento) {
      await calendar.events.delete({ calendarId: prof.calendarId, eventId: evento.id, sendUpdates: 'all' });
      console.log(`🗑 Evento cancelado en Google Calendar: ${evento.id}`);
    }

    // Actualizar en DB
    db.prepare(`UPDATE turnos SET estado = 'cancelado' WHERE cancel_token = ?`).run(token);

    res.json({ ok: true });
  } catch(err) {
    console.error('Error cancelando:', err.message);
    res.status(500).json({ ok: false, error: 'No se pudo cancelar. Comunicate con el centro.' });
  }
});

function paginaCancelacion(tipo, mensaje, turno) {
  const iconos = { error: '❌', ya_cancelado: 'ℹ️', exito: '✅' };
  const titulos = { error: 'No se pudo cancelar', ya_cancelado: 'Turno ya cancelado', exito: '¡Turno cancelado!' };
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Kine House</title>
  <style>body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:white;border-radius:16px;padding:40px 32px;max-width:400px;width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);}
  .icon{font-size:48px;margin-bottom:16px;}
  h2{color:#1C1C1E;font-size:20px;margin:0 0 8px;}
  p{color:#6b6b5a;font-size:15px;margin:0 0 24px;}
  a{display:inline-block;background:#2D4A3E;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;}
  </style></head><body><div class="card">
  <div class="icon">${iconos[tipo] || '❌'}</div>
  <h2>${titulos[tipo] || 'Error'}</h2>
  <p>${mensaje || (turno ? `Tu turno del ${formatFechaDisplay(turno.fecha)} a las ${turno.hora} hs ya estaba cancelado.` : '')}</p>
  <a href="/">Reservar nuevo turno</a>
  </div></body></html>`;
}

function paginaConfirmarCancelacion(token, turno) {
  const prof = PROFESIONALES[turno.profesional] || PROFESIONALES.julian;
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cancelar turno — Kine House</title>
  <style>body{font-family:'Helvetica Neue',Arial,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
  .card{background:white;border-radius:16px;padding:40px 32px;max-width:420px;width:90%;text-align:center;box-shadow:0 4px 20px rgba(0,0,0,0.08);}
  .icon{font-size:48px;margin-bottom:16px;}
  h2{color:#1C1C1E;font-size:20px;margin:0 0 8px;}
  p{color:#6b6b5a;font-size:15px;margin:0 0 20px;}
  .detalle{background:#f8f8f8;border-radius:10px;padding:16px;margin-bottom:24px;text-align:left;}
  .detalle div{font-size:14px;color:#1C1C1E;padding:4px 0;}
  .detalle span{color:#6b6b5a;font-size:12px;display:block;}
  .btn-cancel{background:#A32D2D;color:white;border:none;padding:13px 28px;border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;width:100%;margin-bottom:10px;}
  .btn-cancel:hover{background:#8a2424;}
  .btn-volver{background:none;color:#6b6b5a;border:1px solid #ddd;padding:11px 28px;border-radius:8px;font-size:14px;cursor:pointer;width:100%;}
  .loading{display:none;color:#6b6b5a;font-size:14px;margin-top:12px;}
  </style></head><body><div class="card">
  <div class="icon">⚠️</div>
  <h2>¿Cancelar este turno?</h2>
  <p>Esta acción no se puede deshacer.</p>
  <div class="detalle">
    <div><span>Paciente</span>${turno.nombre}${turno.acompanante ? ' + ' + turno.acompanante : ''}</div>
    <div><span>Fecha</span>${formatFechaDisplay(turno.fecha)}</div>
    <div><span>Horario</span>${turno.hora} hs</div>
    <div><span>Profesional</span>${prof.nombre}</div>
  </div>
  <button class="btn-cancel" onclick="cancelar()">Sí, cancelar turno</button>
  <button class="btn-volver" onclick="window.location='/'">No, volver</button>
  <div class="loading" id="loading">Cancelando...</div>
  </div>
  <script>
  async function cancelar() {
    document.querySelector('.btn-cancel').disabled = true;
    document.querySelector('.btn-volver').disabled = true;
    document.getElementById('loading').style.display = 'block';
    try {
      const r = await fetch('/cancelar', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({token:'${token}'}) });
      const d = await r.json();
      if (d.ok) {
        document.querySelector('.card').innerHTML = '<div class="icon">✅</div><h2>Turno cancelado</h2><p>Tu turno fue cancelado correctamente. Si querés reservar otro, hacé clic abajo.</p><a href="/" style="display:inline-block;background:#2D4A3E;color:white;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:14px;font-weight:600;">Reservar nuevo turno</a>';
      } else {
        alert(d.error || 'No se pudo cancelar');
        document.querySelector('.btn-cancel').disabled = false;
        document.querySelector('.btn-volver').disabled = false;
        document.getElementById('loading').style.display = 'none';
      }
    } catch(e) {
      alert('Error de conexión. Intentá de nuevo.');
      document.querySelector('.btn-cancel').disabled = false;
      document.querySelector('.btn-volver').disabled = false;
      document.getElementById('loading').style.display = 'none';
    }
  }
  </script>
  </body></html>`;
}

// ─── RESERVAR ─────────────────────────────────────────────────────────────────
app.post('/api/reservar', async (req, res) => {
  try {
    const { nombre, email, telefono, fecha, hora, acompanante } = req.body;
    if (!nombre || !email || !fecha || !hora) return res.status(400).json({ error: 'Faltan datos obligatorios' });

    const profId = req.body.profesional || 'julian';
    const prof = PROFESIONALES[profId] || PROFESIONALES.julian;
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const [startHour, startMin] = hora.split(':').map(Number);
    const startTime = `${fecha}T${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;
    const endTime   = `${fecha}T${String(startHour+1).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;

    let descripcion = `Paciente: ${nombre}\nTeléfono: ${telefono}\nEmail: ${email}`;
    if (acompanante) descripcion += `\nAcompañante: ${acompanante}`;
    let titulo = `Turno - ${nombre}`;
    if (acompanante) titulo += ` + ${acompanante}`;

    const response = await calendar.events.insert({
      calendarId: prof.calendarId || 'primary',
      resource: {
        summary: titulo, location: 'Cmte. Piedrabuena 820, A4400 Salta, Argentina',
        description: descripcion,
        start: { dateTime: startTime, timeZone: 'America/Argentina/Salta' },
        end:   { dateTime: endTime,   timeZone: 'America/Argentina/Salta' },
        attendees: [{ email }],
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 30 }, { method: 'popup', minutes: 30 }] },
        sendUpdates: 'all',
      },
      sendNotifications: true,
    });

    const cancelToken = crypto.randomBytes(24).toString('hex');
    const pacienteId = obtenerOCrearPaciente(nombre, profId, email, telefono);
    db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id, cancel_token) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?)`).run(nombre, email||'', telefono||'', acompanante||'', profId, fecha, hora, pacienteId, cancelToken);

    if (acompanante) {
      const pacAcompId = obtenerOCrearPaciente(acompanante, profId, '', '');
      db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id) VALUES (?, '', '', '', ?, ?, ?, 'pendiente', ?)`).run(acompanante, profId, fecha, hora, pacAcompId);
    }

    // Enviar email de confirmación con link de cancelación
    await enviarEmailConfirmacion({ nombre, email, fecha, hora, profesional: profId, cancelToken, acompanante });

    res.json({ ok: true, eventId: response.data.id });
  } catch (err) {
    console.error('Error reservar:', err.message);
    res.status(500).json({ error: 'No se pudo crear el evento.' });
  }
});

// ─── CUPOS ────────────────────────────────────────────────────────────────────
app.get('/api/cupos', async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
    const prof = PROFESIONALES[req.query.profesional] || PROFESIONALES.julian;
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    const response = await calendar.events.list({
      calendarId: prof.calendarId,
      timeMin: `${fecha}T00:00:00-03:00`, timeMax: `${fecha}T23:59:59-03:00`,
      singleEvents: true, orderBy: 'startTime',
    });
    const eventos = response.data.items || [];
    const cupos = {};
    let diaBloqueado = false;
    function timeToMinutes(hhmm) { const [h,m] = hhmm.split(':').map(Number); return h*60+m; }
    function minutesToTime(mins) { return String(Math.floor(mins/60)).padStart(2,'0')+':'+String(mins%60).padStart(2,'0'); }
    eventos.forEach(ev => {
      const titulo = (ev.summary || '').toLowerCase().trim();
      const esBloqueo = PALABRAS_BLOQUEO.some(p => titulo.includes(p));
      if (ev.start?.date && !ev.start?.dateTime && esBloqueo) { diaBloqueado = true; return; }
      if (!ev.start?.dateTime) return;
      const horaInicio = ev.start.dateTime.substring(11,16);
      if (esBloqueo) {
        const ini = timeToMinutes(horaInicio), fin = timeToMinutes(ev.end?.dateTime?.substring(11,16) || horaInicio);
        for (let m = ini; m < fin; m += 30) cupos[minutesToTime(m)] = 999;
      } else {
        cupos[horaInicio] = (cupos[horaInicio] || 0) + ((ev.summary||'').includes(' + ') ? 2 : 1);
      }
    });
    if (diaBloqueado) return res.json({ cupos: {}, diaBloqueado: true });
    res.json({ cupos });
  } catch (err) {
    console.error('Error cupos:', err.message);
    res.status(500).json({ error: 'No se pudieron obtener los cupos' });
  }
});

// ─── PROFESIONALES ────────────────────────────────────────────────────────────
app.get('/api/profesionales', (req, res) => {
  res.json({ profesionales: Object.entries(PROFESIONALES).map(([id,p]) => ({ id, nombre: p.nombre, mp: p.mp })) });
});

// ─── MIDDLEWARE AUTH PANEL ────────────────────────────────────────────────────
function authPanel(req, res, next) {
  if (req.headers['x-panel-password'] !== PANEL_PASSWORD) return res.status(401).json({ error: 'No autorizado' });
  next();
}

// ─── SINCRONIZAR ─────────────────────────────────────────────────────────────
app.post('/api/sincronizar', authPanel, async (req, res) => {
  try {
    const { fecha, profesional } = req.body;
    if (!fecha || !profesional) return res.status(400).json({ error: 'Faltan datos' });
    const profsASincronizar = profesional === 'todos' ? Object.keys(PROFESIONALES) : [profesional];
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
    let agregados = 0, eliminados = 0;
    for (const profId of profsASincronizar) {
      const prof = PROFESIONALES[profId];
      const response = await calendar.events.list({ calendarId: prof.calendarId, timeMin: `${fecha}T00:00:00-03:00`, timeMax: `${fecha}T23:59:59-03:00`, singleEvents: true, orderBy: 'startTime' });
      const eventos = (response.data.items || []).filter(ev => { if (!ev.start?.dateTime) return false; const titulo = (ev.summary || '').toLowerCase(); return !PALABRAS_BLOQUEO.some(p => titulo.includes(p)); });
      const eventosReales = eventos.map(ev => ({ nombre: (ev.summary || '').replace(/^turno\s*[-–]\s*/i, '').trim(), hora: ev.start.dateTime.substring(11, 16) }));
      const turnosDB = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND profesional = ?`).all(fecha, profId);
      for (const turno of turnosDB) {
        if (turno.estado !== 'pendiente') continue;
        const estaEnCalendario = eventosReales.some(ev => ev.hora === turno.hora && ev.nombre.toLowerCase() === turno.nombre.toLowerCase());
        if (!estaEnCalendario) { db.prepare(`DELETE FROM turnos WHERE id = ?`).run(turno.id); eliminados++; }
      }
      for (const ev of eventosReales) {
        const nombres = ev.nombre.includes(' + ') ? ev.nombre.split(' + ').map(n => n.trim()) : [ev.nombre];
        for (const nombre of nombres) {
          const yaExiste = db.prepare(`SELECT id FROM turnos WHERE fecha = ? AND profesional = ? AND hora = ? AND LOWER(nombre) = LOWER(?)`).get(fecha, profId, ev.hora, nombre);
          if (!yaExiste) { const pacienteId = obtenerOCrearPaciente(nombre, profId, '', ''); db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id) VALUES (?, '', '', '', ?, ?, ?, 'pendiente', ?)`).run(nombre, profId, fecha, ev.hora, pacienteId); agregados++; }
        }
      }
    }
    res.json({ ok: true, agregados, eliminados });
  } catch (err) { console.error('Error sincronizar:', err.message); res.status(500).json({ error: 'No se pudo sincronizar' }); }
});

// ─── API PACIENTES ────────────────────────────────────────────────────────────
app.get('/api/pacientes', authPanel, (req, res) => {
  const { profesional } = req.query;
  let query = 'SELECT * FROM pacientes WHERE activo = 1';
  const params = [];
  if (profesional && profesional !== 'todos') { query += ' AND profesional = ?'; params.push(profesional); }
  query += ' ORDER BY nombre ASC';
  res.json({ pacientes: db.prepare(query).all(...params) });
});

app.post('/api/pacientes', authPanel, (req, res) => {
  const { nombre, obra_social, plan, sesiones_total, profesional } = req.body;
  if (!nombre || !sesiones_total || !profesional) return res.status(400).json({ error: 'Faltan datos' });
  const result = db.prepare(`INSERT INTO pacientes (nombre, obra_social, plan, sesiones_total, sesiones_usadas, profesional) VALUES (?, ?, ?, ?, 0, ?)`).run(nombre, obra_social||'', plan||'', parseInt(sesiones_total), profesional);
  res.json({ ok: true, id: result.lastInsertRowid });
});

app.patch('/api/pacientes/:id', authPanel, (req, res) => {
  const p = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  const { nombre, obra_social, plan, sesiones_total, sesiones_usadas, profesional, activo } = req.body;
  const sinCompletar = (obra_social !== undefined && obra_social !== '') ? 0 : p.sin_completar;
  db.prepare(`UPDATE pacientes SET nombre=?, obra_social=?, plan=?, sesiones_total=?, sesiones_usadas=?, profesional=?, activo=?, sin_completar=? WHERE id=?`).run(nombre??p.nombre, obra_social??p.obra_social, plan??p.plan, sesiones_total??p.sesiones_total, sesiones_usadas??p.sesiones_usadas, profesional??p.profesional, activo??p.activo, sinCompletar, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/pacientes/:id', authPanel, (req, res) => {
  db.prepare('UPDATE pacientes SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/pacientes/recientes', authPanel, (req, res) => {
  const { desde, hasta, profesional } = req.query;
  if (!desde || !hasta) return res.status(400).json({ error: 'Faltan fechas' });
  let query = `SELECT p.*, MAX(t.fecha) as ultima_fecha, COUNT(t.id) as turnos_en_rango FROM pacientes p INNER JOIN turnos t ON t.paciente_id = p.id WHERE p.activo = 1 AND t.fecha >= ? AND t.fecha <= ?`;
  const params = [desde, hasta];
  if (profesional && profesional !== 'todos') { query += ' AND p.profesional = ?'; params.push(profesional); }
  query += ' GROUP BY p.id';
  try {
    let pacientes = db.prepare(query).all(...params);
    pacientes.sort((a, b) => { const aF = (a.sin_completar===1||!a.obra_social)?1:0, bF = (b.sin_completar===1||!b.obra_social)?1:0; if (aF!==bF) return bF-aF; return (b.ultima_fecha||'').localeCompare(a.ultima_fecha||''); });
    res.json({ pacientes });
  } catch (err) { console.error('Error pacientes/recientes:', err.message); res.status(500).json({ error: 'Error' }); }
});

// ─── API ASISTENCIA ───────────────────────────────────────────────────────────
app.get('/api/asistencia', authPanel, (req, res) => {
  const { fecha, profesional } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
  let query = `SELECT t.*, p.obra_social, p.plan, p.sesiones_total, p.sesiones_usadas FROM turnos t LEFT JOIN pacientes p ON t.paciente_id = p.id WHERE t.fecha = ?`;
  const params = [fecha];
  if (profesional && profesional !== 'todos') { query += ' AND t.profesional = ?'; params.push(profesional); }
  query += ' ORDER BY t.hora ASC';
  res.json({ turnos: db.prepare(query).all(...params) });
});

app.patch('/api/asistencia/:id', authPanel, (req, res) => {
  const { estado } = req.body;
  if (!['pendiente','asistio','ausente'].includes(estado)) return res.status(400).json({ error: 'Estado inválido' });
  const turno = db.prepare('SELECT * FROM turnos WHERE id = ?').get(req.params.id);
  if (!turno) return res.status(404).json({ error: 'No encontrado' });
  db.transaction(() => {
    db.prepare('UPDATE turnos SET estado = ? WHERE id = ?').run(estado, req.params.id);
    if (turno.paciente_id) {
      if (estado === 'asistio' && turno.estado !== 'asistio') db.prepare('UPDATE pacientes SET sesiones_usadas = sesiones_usadas + 1 WHERE id = ? AND sesiones_usadas < sesiones_total').run(turno.paciente_id);
      if (turno.estado === 'asistio' && estado !== 'asistio') db.prepare('UPDATE pacientes SET sesiones_usadas = MAX(0, sesiones_usadas - 1) WHERE id = ?').run(turno.paciente_id);
    }
  })();
  res.json({ ok: true });
});

app.post('/api/asistencia/manual', authPanel, (req, res) => {
  const { nombre, profesional, fecha, hora } = req.body;
  if (!nombre || !profesional || !fecha || !hora) return res.status(400).json({ error: 'Faltan datos' });
  db.transaction(() => {
    const pacienteId = obtenerOCrearPaciente(nombre, profesional, '', '');
    db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id) VALUES (?, '', '', '', ?, ?, ?, 'asistio', ?)`).run(nombre, profesional, fecha, hora, pacienteId);
    db.prepare('UPDATE pacientes SET sesiones_usadas = sesiones_usadas + 1 WHERE id = ? AND sesiones_usadas < sesiones_total').run(pacienteId);
  })();
  res.json({ ok: true });
});

app.post('/api/asistencia/cerrar-dia', authPanel, (req, res) => {
  const { fecha } = req.body;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });
  const pendientes = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND estado = 'pendiente'`).all(fecha);
  db.transaction(() => {
    pendientes.forEach(t => {
      db.prepare(`UPDATE turnos SET estado = 'asistio' WHERE id = ?`).run(t.id);
      if (t.paciente_id) db.prepare('UPDATE pacientes SET sesiones_usadas = sesiones_usadas + 1 WHERE id = ? AND sesiones_usadas < sesiones_total').run(t.paciente_id);
    });
  })();
  res.json({ ok: true, actualizados: pendientes.length });
});

// ─── API PLANILLA DE ASISTENCIA ──────────────────────────────────────────────
// Listar pacientes de un profesional con sus sesiones del mes
app.get('/api/planilla', authPanel, (req, res) => {
  const { profesional, mes } = req.query;
  if (!profesional || !mes) return res.status(400).json({ error: 'Faltan datos' });
  const pacs = db.prepare(`SELECT * FROM planilla_pacientes WHERE profesional = ? AND mes = ? AND activo = 1 ORDER BY id ASC`).all(profesional, mes);
  const result = pacs.map(p => {
    const sesiones = db.prepare(`SELECT col, fecha, pagada FROM planilla_sesiones WHERE paciente_id = ? AND mes = ? ORDER BY col ASC`).all(p.id, mes);
    return { ...p, sesiones };
  });
  res.json({ pacientes: result });
});

// Crear paciente
app.post('/api/planilla/pacientes', authPanel, (req, res) => {
  const { nombre, obra_social, sesiones_autorizadas, telefono, observaciones, profesional, mes } = req.body;
  if (!profesional || !mes) return res.status(400).json({ error: 'Faltan datos' });
  const r = db.prepare(`INSERT INTO planilla_pacientes (nombre, obra_social, sesiones_autorizadas, telefono, observaciones, profesional, mes) VALUES (?,?,?,?,?,?,?)`)
    .run(nombre||'', obra_social||'', parseInt(sesiones_autorizadas)||10, telefono||'', observaciones||'', profesional, mes);
  res.json({ ok: true, id: r.lastInsertRowid });
});

// Actualizar datos de paciente
app.patch('/api/planilla/pacientes/:id', authPanel, (req, res) => {
  const p = db.prepare('SELECT * FROM planilla_pacientes WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  const { nombre, obra_social, sesiones_autorizadas, telefono, observaciones } = req.body;
  db.prepare(`UPDATE planilla_pacientes SET nombre=?, obra_social=?, sesiones_autorizadas=?, telefono=?, observaciones=? WHERE id=?`)
    .run(nombre??p.nombre, obra_social??p.obra_social, sesiones_autorizadas??p.sesiones_autorizadas, telefono??p.telefono, observaciones??p.observaciones, req.params.id);
  res.json({ ok: true });
});

// Eliminar (desactivar) paciente
app.delete('/api/planilla/pacientes/:id', authPanel, (req, res) => {
  db.prepare('UPDATE planilla_pacientes SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// Guardar/actualizar una celda de sesión (fecha y/o pagada)
app.put('/api/planilla/sesion', authPanel, (req, res) => {
  const { paciente_id, mes, col, fecha, pagada } = req.body;
  if (!paciente_id || !mes || col === undefined) return res.status(400).json({ error: 'Faltan datos' });
  db.prepare(`
    INSERT INTO planilla_sesiones (paciente_id, mes, col, fecha, pagada)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(paciente_id, mes, col) DO UPDATE SET fecha = excluded.fecha, pagada = excluded.pagada
  `).run(paciente_id, mes, col, fecha||'', pagada?1:0);
  res.json({ ok: true });
});

// ─── HELPERS DE COLOR Y ESCAPE ───────────────────────────────────────────────
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function darken(hex, f){
  // f: 0..1 cuánto oscurecer
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(String(hex||'').trim());
  if(!m) return '#56583a';
  let r=parseInt(m[1],16), g=parseInt(m[2],16), b=parseInt(m[3],16);
  r=Math.round(r*(1-f)); g=Math.round(g*(1-f)); b=Math.round(b*(1-f));
  const h=n=>('0'+n.toString(16)).slice(-2);
  return '#'+h(r)+h(g)+h(b);
}

// ─── RENDER DE LA LANDING DESDE LA CONFIG ────────────────────────────────────
function renderLanding(cfg){
  const olive = (cfg.color && /^#?[a-f\d]{6}$/i.test(cfg.color.replace('#',''))) ? (cfg.color[0]==='#'?cfg.color:'#'+cfg.color) : '#8a8c52';
  const oliveDark = darken(olive, 0.28);
  const oliveDeep = darken(olive, 0.48);
  const logoSrc = hasMedia('logo') ? '/media/logo' : '/03%20KINE%20ISO%20COMBINADO.png';
  const heroHas = hasMedia('hero');
  const nosHas  = hasMedia('nosotros');

  const h = cfg.hero||{}, se=cfg.servicios||{}, no=cfg.nosotros||{}, eq=cfg.equipo||{}, ub=cfg.ubicacion||{}, ct=cfg.cta||{};

  const servItems = (se.items||[]).map((it,i)=>`
        <div class="scard"><div class="ic">${esc(it.icono)}</div><h3>${esc(it.nombre)}</h3><p>${esc(it.desc)}</p><div class="arrow">→</div></div>`);
  // agrupar en filas de 2
  let servRows='';
  for(let i=0;i<servItems.length;i+=2){ servRows+=`<div class="brow">${servItems.slice(i,i+2).join('')}</div>`; }

  const msgWaBase = (typeof eq.mensajeWa === 'string' && eq.mensajeWa.trim()) ? eq.mensajeWa : DEFAULT_WEB.equipo.mensajeWa;
  const teamItems = (eq.items||[]).map((m,i)=>{
    const tel = String(m.tel||'').replace(/[^\d]/g,'');
    const msgWa = msgWaBase.replace(/\{nombre\}/g, String(m.nombre||'').trim());
    const waHref = 'https://wa.me/' + tel + '?text=' + encodeURIComponent(msgWa);
    const contacto = tel ? `
          <div class="tcontact">
            <button type="button" class="tcbtn" onclick="toggleContacto(${i})">Contactar</button>
            <div class="tcopts" id="tcopts-${i}">
              <a href="tel:+${tel}" class="tcopt call">📞 Llamar</a>
              <a href="${esc(waHref)}" target="_blank" rel="noopener noreferrer" class="tcopt wa">💬 WhatsApp</a>
            </div>
          </div>` : '';
    const avatar = hasMedia('equipo-'+i)
      ? `<div class="tavatar" style="background-image:url(/media/equipo-${i});background-size:cover;background-position:center;"></div>`
      : `<div class="tavatar">${esc(m.iniciales)}</div>`;
    return `
        <div class="tmember">${avatar}<h3>${esc(m.nombre)}</h3><div class="role">${esc(m.rol)}</div><span class="mp">${esc(m.mp)}</span>${contacto}</div>`;
  }).join('');

  const secServicios = se.visible===false ? '' : `
  <section class="section" id="servicios">
    <div class="wrap">
      <div class="sec-head">
        <div><span class="tag"><span class="dot"></span> Qué hacemos</span>
          <h2 class="sec-title" style="margin-top:14px;">${esc(se.titulo)}</h2></div>
        <p class="sec-sub">${esc(se.sub)}</p>
      </div>
      ${servRows}
    </div>
  </section>`;

  const secNosotros = no.visible===false ? '' : `
  <section class="section" style="padding-top:0;">
    <div class="wrap">
      <div class="about">
        <div class="about-txt">
          <span class="tag"><span class="dot"></span> Quiénes somos</span>
          <h2>${esc(no.titulo)}</h2>
          <p>${esc(no.p1)}</p>
          <p>${esc(no.p2)}</p>
        </div>
        <div class="about-visual" style="${nosHas?`background-image:url(/media/nosotros);background-size:cover;background-position:center;`:''}">
          ${nosHas?'':`<div class="ph"><img src="${logoSrc}" alt=""><span>Foto del equipo</span></div>`}
        </div>
      </div>
    </div>
  </section>`;

  const secEquipo = eq.visible===false ? '' : `
  <section class="section" style="padding-top:0;">
    <div class="wrap">
      <div class="sec-head"><div><span class="tag"><span class="dot"></span> Nuestro equipo</span>
        <h2 class="sec-title" style="margin-top:14px;">${esc(eq.titulo)}</h2></div></div>
      <div class="team-grid">${teamItems}</div>
    </div>
  </section>`;

  const secUbic = ub.visible===false ? '' : `
        <div class="close-loc">
          <span class="tag"><span class="dot"></span> Ubicación</span>
          <div class="addr">${esc(ub.direccion)}</div>
          <div class="city">${esc(ub.ciudad)}</div>
          <a href="${esc(ub.maps)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost">Ver en Google Maps ↗</a>
        </div>`;

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="${oliveDeep}">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Kine House">
  <link rel="apple-touch-icon" href="/icon-192.png">
  <title>Kine House — Centro de Kinesiología y Fisioterapia</title>
  <meta property="og:title" content="Kine House">
  <meta property="og:description" content="Centro de Kinesiología y Fisioterapia · Readaptación Física en Salta">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=DM+Sans:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root{
      --bg:#faf8f4; --bg-2:#f4f0e8; --card:#ffffff;
      --olive:${olive}; --olive-dark:${oliveDark}; --olive-deep:${oliveDeep};
      --ink:#26261f; --muted:#8a877a; --line:#ece7db; --accent:#c7643c;
      --display:'Space Grotesk',sans-serif; --sans:'DM Sans',sans-serif; --r:22px;
    }
    *{box-sizing:border-box;margin:0;padding:0;}
    html{scroll-behavior:smooth;}
    body{font-family:var(--sans);background:var(--bg);color:var(--ink);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden;}
    a{color:inherit;text-decoration:none;} img{max-width:100%;display:block;}
    .wrap{max-width:1120px;margin:0 auto;padding:0 22px;}
    .tag{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;padding:7px 14px;border-radius:99px;background:rgba(138,140,82,0.12);color:var(--olive-dark);}
    .tag .dot{width:6px;height:6px;border-radius:50%;background:var(--olive);}
    .nav{position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:100;width:calc(100% - 28px);max-width:1120px;display:flex;align-items:center;justify-content:space-between;padding:11px 12px 11px 20px;background:rgba(255,255,255,0.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid var(--line);border-radius:99px;box-shadow:0 6px 24px rgba(74,76,44,0.06);}
    .nav-brand{display:flex;align-items:center;gap:10px;font-family:var(--display);font-size:18px;font-weight:600;color:var(--ink);}
    .nav-brand .iso{width:30px;height:30px;border-radius:9px;object-fit:contain;background:#fff;padding:2px;border:1px solid var(--line);}
    .nav-right{display:flex;align-items:center;gap:6px;}
    .nav-link{font-size:14px;font-weight:500;color:var(--muted);padding:9px 14px;border-radius:99px;transition:.15s;}
    .nav-link:hover{color:var(--ink);background:var(--bg-2);}
    .nav-cta{font-size:14px;font-weight:600;color:#fff;background:var(--ink);padding:11px 20px;border-radius:99px;transition:.15s;}
    .nav-cta:hover{background:var(--olive-dark);}
    @media(max-width:640px){ .nav-link.hs{display:none;} }
    .hero{position:relative;min-height:88vh;display:flex;align-items:flex-end;overflow:hidden;}
    .hero-photo{position:absolute;inset:0;background:linear-gradient(150deg,var(--olive) 0%,var(--olive-deep) 100%);${heroHas?`background-image:url(/media/hero);background-size:cover;background-position:center;`:''}}
    .hero-photo .hero-ph{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:rgba(255,255,255,0.4);}
    .hero-photo .hero-ph img{width:120px;filter:brightness(0) invert(1);opacity:0.5;}
    .hero-photo .hero-ph span{font-size:12px;letter-spacing:0.18em;text-transform:uppercase;}
    .hero-overlay{position:absolute;inset:0;background:linear-gradient(to top, rgba(30,30,24,0.78) 0%, rgba(30,30,24,0.35) 45%, rgba(30,30,24,0.15) 100%);}
    .hero-content{position:relative;z-index:2;padding-bottom:74px;padding-top:140px;color:#fff;max-width:1120px;}
    .hero-content .tag.light{background:rgba(255,255,255,0.16);color:#fff;}
    .hero-content .tag.light .dot{background:#fff;}
    .hero-content h1{font-family:var(--display);font-weight:600;font-size:64px;line-height:1.0;letter-spacing:-0.03em;margin:22px 0 18px;color:#fff;}
    .hero-content h1 .hl{color:#e7e4c8;}
    .hero-content p{font-size:19px;color:rgba(255,255,255,0.85);max-width:460px;font-weight:300;margin-bottom:34px;}
    .hero-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center;}
    .btn{display:inline-flex;align-items:center;gap:9px;font-family:var(--sans);font-size:16px;font-weight:600;padding:15px 30px;border-radius:99px;cursor:pointer;transition:.15s;border:none;}
    .btn-primary{background:#fff;color:var(--ink);box-shadow:0 10px 26px rgba(0,0,0,0.18);}
    .btn-primary:hover{background:var(--bg-2);transform:translateY(-2px);}
    .btn-light{background:rgba(255,255,255,0.14);color:#fff;border:1.5px solid rgba(255,255,255,0.35);}
    .btn-light:hover{background:rgba(255,255,255,0.24);}
    .btn-ghost{background:#fff;color:var(--ink);border:1.5px solid var(--line);}
    .btn-ghost:hover{border-color:var(--olive);}
    @media(max-width:640px){ .hero-content h1{font-size:42px;} .hero{min-height:82vh;} .hero-content{padding-bottom:52px;} }
    .section{padding:88px 0;}
    .sec-head{display:flex;align-items:flex-end;justify-content:space-between;gap:20px;margin-bottom:40px;flex-wrap:wrap;}
    .sec-title{font-family:var(--display);font-weight:600;font-size:36px;line-height:1.08;letter-spacing:-0.02em;}
    .sec-sub{color:var(--muted);max-width:400px;font-weight:300;}
    @media(max-width:640px){ .section{padding:60px 0;} .sec-title{font-size:28px;} }
    .brow{display:flex;justify-content:space-between;margin-bottom:16px;}
    .scard{width:48.5%;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:30px 28px;transition:.2s;position:relative;overflow:hidden;}
    .scard:hover{transform:translateY(-5px);box-shadow:0 20px 44px rgba(74,76,44,0.10);border-color:transparent;}
    .scard .ic{width:52px;height:52px;border-radius:15px;display:flex;align-items:center;justify-content:center;font-size:25px;margin-bottom:18px;background:rgba(138,140,82,0.13);}
    .scard h3{font-family:var(--display);font-size:20px;font-weight:600;margin-bottom:8px;}
    .scard p{font-size:14.5px;color:var(--muted);font-weight:300;line-height:1.6;}
    .scard .arrow{margin-top:14px;color:var(--olive);font-size:20px;opacity:0;transform:translateX(-6px);transition:.2s;}
    .scard:hover .arrow{opacity:1;transform:translateX(0);}
    @media(max-width:680px){ .brow{flex-direction:column;} .scard{width:100%;margin-bottom:16px;} }
    .about{background:var(--bg-2);border-radius:34px;padding:56px 52px;display:flex;justify-content:space-between;align-items:center;}
    .about-txt{width:54%;}
    .about-txt h2{font-family:var(--display);font-weight:600;font-size:32px;letter-spacing:-0.02em;margin:14px 0 16px;line-height:1.12;}
    .about-txt p{color:var(--muted);font-weight:300;margin-bottom:14px;}
    .about-visual{width:40%;height:300px;border-radius:24px;background:linear-gradient(150deg,var(--olive),var(--olive-deep));position:relative;overflow:hidden;display:flex;align-items:center;justify-content:center;box-shadow:0 20px 50px rgba(74,76,44,0.18);}
    .about-visual .ph{color:rgba(255,255,255,0.6);text-align:center;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;}
    .about-visual .ph img{width:80px;margin:0 auto 10px;filter:brightness(0) invert(1);opacity:.85;}
    @media(max-width:820px){ .about{flex-direction:column;padding:38px 26px;} .about-txt{width:100%;margin-bottom:24px;} .about-visual{width:100%;height:220px;} }
    .team-grid{display:flex;justify-content:space-between;}
    .tmember{width:32%;background:var(--card);border:1px solid var(--line);border-radius:var(--r);padding:30px 24px;text-align:center;transition:.2s;}
    .tmember:hover{transform:translateY(-4px);box-shadow:0 18px 40px rgba(74,76,44,0.10);}
    .tavatar{width:78px;height:78px;border-radius:24px;margin:0 auto 16px;background:linear-gradient(145deg,var(--olive),var(--olive-dark));display:flex;align-items:center;justify-content:center;font-family:var(--display);font-size:24px;font-weight:600;color:#fff;}
    .tmember h3{font-family:var(--display);font-size:18px;font-weight:600;margin-bottom:3px;}
    .tmember .role{font-size:13px;color:var(--muted);margin-bottom:10px;}
    .tmember .mp{display:inline-block;font-size:12px;font-weight:600;color:var(--olive-dark);background:rgba(138,140,82,0.12);border-radius:99px;padding:4px 13px;}
    .tcontact{margin-top:16px;}
    .tcbtn{font:inherit;font-size:13px;font-weight:600;color:#fff;background:var(--olive-dark);border:none;border-radius:99px;padding:9px 22px;cursor:pointer;transition:.15s;}
    .tcbtn:hover{background:var(--olive-deep);}
    .tcopts{display:none;flex-direction:column;gap:8px;margin-top:12px;}
    .tcopts.open{display:flex;}
    .tcopt{display:flex;align-items:center;justify-content:center;gap:8px;font-size:14px;font-weight:600;padding:11px 16px;border-radius:12px;transition:.15s;}
    .tcopt.call{background:var(--bg-2);color:var(--ink);border:1px solid var(--line);}
    .tcopt.call:hover{border-color:var(--olive);}
    .tcopt.wa{background:#25d366;color:#fff;}
    .tcopt.wa:hover{background:#1eb955;}
    @media(max-width:720px){ .team-grid{flex-direction:column;} .tmember{width:100%;margin-bottom:14px;} }
    .close{display:flex;justify-content:space-between;}
    .close-cta{width:57%;background:linear-gradient(150deg,var(--ink),var(--olive-deep));color:#fff;border-radius:30px;padding:52px 46px;position:relative;overflow:hidden;}
    .close-cta .blob{position:absolute;width:220px;height:220px;border-radius:50%;background:rgba(199,100,60,0.25);top:-70px;right:-50px;filter:blur(6px);}
    .close-cta h2{font-family:var(--display);font-weight:600;font-size:34px;letter-spacing:-0.02em;margin-bottom:12px;position:relative;line-height:1.1;}
    .close-cta p{color:rgba(255,255,255,0.75);font-weight:300;margin-bottom:28px;position:relative;}
    .close-cta .btn-primary{background:#fff;color:var(--ink);position:relative;}
    .close-loc{width:40%;background:var(--card);border:1px solid var(--line);border-radius:30px;padding:40px 34px;display:flex;flex-direction:column;justify-content:center;}
    .close-loc .tag{margin-bottom:16px;} .close-loc .addr{font-family:var(--display);font-size:22px;font-weight:600;margin-bottom:4px;} .close-loc .city{color:var(--muted);margin-bottom:22px;}
    @media(max-width:760px){ .close{flex-direction:column;} .close-cta,.close-loc{width:100%;padding:36px 28px;margin-bottom:16px;} .close-cta h2{font-size:28px;} }
    .footer{padding:50px 0 40px;border-top:1px solid var(--line);margin-top:80px;}
    .footer-inner{display:flex;flex-wrap:wrap;justify-content:space-between;gap:24px;align-items:center;}
    .footer-brand{display:flex;align-items:center;gap:11px;font-family:var(--display);font-size:19px;font-weight:600;}
    .footer-brand .iso{width:34px;height:34px;border-radius:9px;background:#fff;padding:2px;border:1px solid var(--line);object-fit:contain;}
    .footer-links{display:flex;gap:22px;flex-wrap:wrap;font-size:14px;color:var(--muted);}
    .footer-links a:hover{color:var(--ink);}
    .footer-copy{width:100%;margin-top:26px;padding-top:22px;border-top:1px solid var(--line);font-size:12.5px;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;}
  </style>
</head>
<body>
  <nav class="nav">
    <a href="#top" class="nav-brand"><img class="iso" src="${logoSrc}" alt="">Kine House</a>
    <div class="nav-right">
      ${se.visible===false?'':'<a href="#servicios" class="nav-link hs">Servicios</a>'}
      <a href="/staff" class="nav-link hs">Equipo</a>
      <a href="/" class="nav-cta">Agendar turno</a>
    </div>
  </nav>

  <header class="hero" id="top">
    <div class="hero-photo">${heroHas?'':`<div class="hero-ph"><img src="${logoSrc}" alt=""><span>Foto del centro</span></div>`}</div>
    <div class="hero-overlay"></div>
    <div class="wrap hero-content">
      <span class="tag light"><span class="dot"></span> ${esc(h.tag)}</span>
      <h1>${esc(h.titulo)}<br><span class="hl">${esc(h.destacado)}</span></h1>
      <p>${esc(h.sub)}</p>
      <div class="hero-actions">
        <a href="/" class="btn btn-primary">Agendar un turno →</a>
        ${se.visible===false?'':'<a href="#servicios" class="btn btn-light">Ver servicios</a>'}
      </div>
    </div>
  </header>
${secServicios}
${secNosotros}
${secEquipo}
  <section class="section" style="padding-top:0;" id="agendar">
    <div class="wrap">
      <div class="close">
        <div class="close-cta">
          <span class="blob"></span>
          <h2>${esc(ct.titulo)}</h2>
          <p>${esc(ct.sub)}</p>
          <a href="/" class="btn btn-primary">Agendar un turno →</a>
        </div>
${secUbic}
      </div>
    </div>
  </section>

  <footer class="footer">
    <div class="wrap">
      <div class="footer-inner">
        <a href="#top" class="footer-brand"><img class="iso" src="${logoSrc}" alt="">Kine House</a>
        <div class="footer-links">
          ${se.visible===false?'':'<a href="#servicios">Servicios</a>'}
          <a href="/">Agendar turno</a>
          <a href="/staff">Acceso equipo</a>
          ${ub.visible===false?'':`<a href="${esc(ub.maps)}" target="_blank" rel="noopener noreferrer">Ubicación</a>`}
        </div>
      </div>
      <div class="footer-copy">
        <span>© <span id="yr"></span> Kine House · Rehabilitación &amp; Movimiento</span>
        <span>${esc(ub.direccion)}, ${esc(ub.ciudad)}</span>
      </div>
    </div>
  </footer>
  <script>
    document.getElementById('yr').textContent = new Date().getFullYear();
    function toggleContacto(i){
      var el = document.getElementById('tcopts-'+i);
      var abierto = el.classList.contains('open');
      var todos = document.querySelectorAll('.tcopts');
      for (var k=0;k<todos.length;k++) todos[k].classList.remove('open');
      if(!abierto) el.classList.add('open');
    }
    if ('serviceWorker' in navigator) { window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(()=>{}); }); }
  </script>
</body>
</html>`;
}

// ─── ENDPOINTS WEB ───────────────────────────────────────────────────────────
app.get('/api/web', (req, res) => { res.json(getWebConfig()); });

app.post('/api/web', authPanel, (req, res) => {
  try { setWebConfig(req.body || {}); res.json({ ok: true }); }
  catch(e){ res.status(500).json({ error: e.message }); }
});

app.post('/api/web/upload', authPanel, (req, res) => {
  const { clave, dataUri } = req.body || {};
  if (!/^(logo|hero|nosotros|equipo-\d+)$/.test(clave)) return res.status(400).json({ error: 'Clave inválida' });
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUri||'');
  if (!m) return res.status(400).json({ error: 'Imagen inválida' });
  db.prepare("INSERT INTO web_media (clave, mime, datos, actualizado) VALUES (?,?,?,datetime('now','-3 hours')) ON CONFLICT(clave) DO UPDATE SET mime=excluded.mime, datos=excluded.datos, actualizado=excluded.actualizado")
    .run(clave, m[1], m[2]);
  res.json({ ok: true });
});

app.delete('/api/web/upload/:clave', authPanel, (req, res) => {
  db.prepare("DELETE FROM web_media WHERE clave = ?").run(req.params.clave);
  res.json({ ok: true });
});

app.get('/media/:clave', (req, res) => {
  const row = db.prepare("SELECT mime, datos FROM web_media WHERE clave = ?").get(req.params.clave);
  if (!row) return res.status(404).send('Sin imagen');
  res.set('Content-Type', row.mime);
  res.set('Cache-Control', 'no-cache');
  res.send(Buffer.from(row.datos, 'base64'));
});

app.get('/asistencia', (req, res) => res.sendFile(path.join(__dirname, 'public', 'asistencia.html')));
app.get('/agenda', (req, res) => res.sendFile(path.join(__dirname, 'public', 'agenda.html')));
app.get('/inicio', (req, res) => { res.set('Cache-Control','no-cache'); res.send(renderLanding(getWebConfig())); });
app.get('/admin-web', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-web.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
