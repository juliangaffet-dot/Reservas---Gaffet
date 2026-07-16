const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
app.use(express.json());
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

// Migraciones suaves
try { db.exec(`ALTER TABLE pacientes ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN telefono TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN sin_completar INTEGER NOT NULL DEFAULT 1`); } catch(e) {}
try { db.exec(`ALTER TABLE turnos ADD COLUMN cancel_token TEXT`); } catch(e) {}

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
  if (slotTime - new Date() < 2 * 60 * 60 * 1000) {
    return res.send(paginaCancelacion('error', 'No se puede cancelar con menos de 2 horas de anticipación. Comunicate directamente con el centro.'));
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

app.get('/asistencia', (req, res) => res.sendFile(path.join(__dirname, 'public', 'asistencia.html')));
app.get('/inicio', (req, res) => res.sendFile(path.join(__dirname, 'public', 'inicio.html')));
app.get('/staff', (req, res) => res.sendFile(path.join(__dirname, 'public', 'staff.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
