const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── BASE DE DATOS SQLite ─────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'asistencia.db'));

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
    creado_en TEXT DEFAULT (datetime('now','-3 hours'))
  );
`);
// ─────────────────────────────────────────────────────────────────────────────

// ─── CONFIGURACIÓN GOOGLE CALENDAR ───────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'kinehouse2025';
// ─────────────────────────────────────────────────────────────────────────────

// ─── PROFESIONALES ────────────────────────────────────────────────────────────
const PROFESIONALES = {
  julian: {
    nombre: 'Lic. Julián Gaffet',
    mp: '1321',
    calendarId: 'primary'
  },
  mauro: {
    nombre: 'Lic. Mauro Ayub',
    mp: '1263',
    calendarId: 'mauroayub@gmail.com'
  },
  esteban: {
    nombre: 'Lic. Esteban Videla',
    mp: '1337',
    calendarId: 'tebyvidela@gmail.com'
  }
};
// ─────────────────────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

// ─── JOB AUTOMÁTICO: marcar asistencia a las 21hs ────────────────────────────
function getHoraArgentina() {
  const now = new Date();
  // UTC-3
  const arg = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return { hora: arg.getUTCHours(), minuto: arg.getUTCMinutes() };
}

function getFechaArgentina() {
  const now = new Date();
  const arg = new Date(now.getTime() - 3 * 60 * 60 * 1000);
  return arg.toISOString().substring(0, 10);
}

function marcarAsistenciaDelDia() {
  const hoy = getFechaArgentina();
  const resultado = db.prepare(`
    UPDATE turnos
    SET estado = 'asistio'
    WHERE fecha = ? AND estado = 'pendiente'
  `).run(hoy);
  console.log(`✅ Asistencia automática: ${resultado.changes} turno(s) marcados como asistió para ${hoy}`);
}

// Revisar cada minuto si son las 21:00
setInterval(() => {
  const { hora, minuto } = getHoraArgentina();
  if (hora === 21 && minuto === 0) {
    marcarAsistenciaDelDia();
  }
}, 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// Paso 1: ruta para autorizar
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(url);
});

// Paso 2: callback de Google
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\n✅ REFRESH TOKEN OBTENIDO:\n', tokens.refresh_token);
  res.send('<h2>✅ Autorización exitosa!</h2><p>Copiá el refresh_token de la consola y configuralo como variable de entorno.</p>');
});

// ─── RUTA PRINCIPAL: crear reserva ───────────────────────────────────────────
app.post('/api/reservar', async (req, res) => {
  try {
    const { nombre, email, telefono, fecha, hora, acompanante } = req.body;

    if (!nombre || !email || !fecha || !hora) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const profId = req.body.profesional || 'julian';
    const prof = PROFESIONALES[profId] || PROFESIONALES.julian;
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const [startHour, startMin] = hora.split(':').map(Number);
    const endHour = startHour + 1;

    const startTime = `${fecha}T${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;
    const endTime   = `${fecha}T${String(endHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;

    let descripcion = `Paciente: ${nombre}\nTeléfono: ${telefono}\nEmail: ${email}`;
    if (acompanante) descripcion += `\nAcompañante: ${acompanante}`;

    let titulo = `Turno - ${nombre}`;
    if (acompanante) titulo += ` + ${acompanante}`;

    const event = {
      summary: titulo,
      location: 'Cmte. Piedrabuena 820, A4400 Salta, Argentina',
      description: descripcion,
      start: { dateTime: startTime, timeZone: 'America/Argentina/Salta' },
      end:   { dateTime: endTime,   timeZone: 'America/Argentina/Salta' },
      attendees: [{ email }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 30 },
          { method: 'popup',  minutes: 30 },
        ],
      },
      sendUpdates: 'all',
    };

    const response = await calendar.events.insert({
      calendarId: prof.calendarId || 'primary',
      resource: event,
      sendNotifications: true,
    });

    // ─── GUARDAR EN BASE DE DATOS ─────────────────────────────────────────
    db.prepare(`
      INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')
    `).run(nombre, email || '', telefono || '', acompanante || '', profId, fecha, hora);

    // Si hay acompañante, también lo guardamos como registro separado
    if (acompanante) {
      db.prepare(`
        INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente')
      `).run(acompanante, '', '', '', profId, fecha, hora);
    }
    // ─────────────────────────────────────────────────────────────────────

    res.json({ ok: true, eventId: response.data.id, link: response.data.htmlLink });

  } catch (err) {
    console.error('Error creando evento:', err.message);
    res.status(500).json({ error: 'No se pudo crear el evento. Revisá la configuración.' });
  }
});

// ─── RUTA: obtener cupos ocupados para un día ─────────────────────────────────
app.get('/api/cupos', async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

    const prof = PROFESIONALES[req.query.profesional] || PROFESIONALES.julian;

    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const timeMin = `${fecha}T00:00:00-03:00`;
    const timeMax = `${fecha}T23:59:59-03:00`;

    const response = await calendar.events.list({
      calendarId: prof.calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    const cupos = {};
    const bloqueados = {};

    const PALABRAS_BLOQUEO = ['bloqueado', 'no disponible', 'feriado', 'cerrado', 'ocupado', 'no atiende'];

    function timeToMinutes(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    }
    function minutesToTime(mins) {
      return String(Math.floor(mins/60)).padStart(2,'0') + ':' + String(mins%60).padStart(2,'0');
    }

    eventos.forEach(ev => {
      const titulo = (ev.summary || '').toLowerCase().trim();
      const esBloqueo = PALABRAS_BLOQUEO.some(p => titulo.includes(p));

      if (ev.start?.date && !ev.start?.dateTime && esBloqueo) {
        bloqueados['DIA_COMPLETO'] = true;
        return;
      }

      if (!ev.start?.dateTime) return;

      const horaInicio = ev.start.dateTime.substring(11, 16);
      const horaFin = ev.end?.dateTime ? ev.end.dateTime.substring(11, 16) : horaInicio;

      if (esBloqueo) {
        const inicioMins = timeToMinutes(horaInicio);
        const finMins = timeToMinutes(horaFin);
        for (let m = inicioMins; m < finMins; m += 30) {
          cupos[minutesToTime(m)] = 999;
        }
      } else {
        const tieneAcompanante = (ev.summary || '').includes(' + ');
        const cuposUsados = tieneAcompanante ? 2 : 1;
        cupos[horaInicio] = (cupos[horaInicio] || 0) + cuposUsados;
      }
    });

    if (bloqueados['DIA_COMPLETO']) {
      return res.json({ cupos: {}, diaBloqueado: true });
    }

    res.json({ cupos });

  } catch (err) {
    console.error('Error obteniendo cupos:', err.message);
    res.status(500).json({ error: 'No se pudieron obtener los cupos' });
  }
});

// ─── RUTA: listar profesionales ──────────────────────────────────────────────
app.get('/api/profesionales', (req, res) => {
  const lista = Object.entries(PROFESIONALES).map(([id, p]) => ({
    id,
    nombre: p.nombre,
    mp: p.mp
  }));
  res.json({ profesionales: lista });
});

// ─── API ASISTENCIA: listar turnos de un día ──────────────────────────────────
app.get('/api/asistencia', (req, res) => {
  const pass = req.headers['x-panel-password'];
  if (pass !== PANEL_PASSWORD) return res.status(401).json({ error: 'No autorizado' });

  const { fecha, profesional } = req.query;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

  let query = 'SELECT * FROM turnos WHERE fecha = ?';
  const params = [fecha];

  if (profesional && profesional !== 'todos') {
    query += ' AND profesional = ?';
    params.push(profesional);
  }

  query += ' ORDER BY hora ASC';
  const turnos = db.prepare(query).all(...params);
  res.json({ turnos });
});

// ─── API ASISTENCIA: actualizar estado de un turno ───────────────────────────
app.patch('/api/asistencia/:id', (req, res) => {
  const pass = req.headers['x-panel-password'];
  if (pass !== PANEL_PASSWORD) return res.status(401).json({ error: 'No autorizado' });

  const { estado } = req.body;
  const { id } = req.params;
  const estados = ['pendiente', 'asistio', 'ausente'];
  if (!estados.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

  db.prepare('UPDATE turnos SET estado = ? WHERE id = ?').run(estado, id);
  res.json({ ok: true });
});

// ─── API ASISTENCIA: agregar paciente sin turno ───────────────────────────────
app.post('/api/asistencia/manual', (req, res) => {
  const pass = req.headers['x-panel-password'];
  if (pass !== PANEL_PASSWORD) return res.status(401).json({ error: 'No autorizado' });

  const { nombre, profesional, fecha, hora } = req.body;
  if (!nombre || !profesional || !fecha || !hora) {
    return res.status(400).json({ error: 'Faltan datos' });
  }

  db.prepare(`
    INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado)
    VALUES (?, '', '', '', ?, ?, ?, 'asistio')
  `).run(nombre, profesional, fecha, hora);

  res.json({ ok: true });
});

// ─── API ASISTENCIA: marcar día completo manualmente ─────────────────────────
app.post('/api/asistencia/cerrar-dia', (req, res) => {
  const pass = req.headers['x-panel-password'];
  if (pass !== PANEL_PASSWORD) return res.status(401).json({ error: 'No autorizado' });

  const { fecha } = req.body;
  if (!fecha) return res.status(400).json({ error: 'Falta fecha' });

  const resultado = db.prepare(`
    UPDATE turnos SET estado = 'asistio' WHERE fecha = ? AND estado = 'pendiente'
  `).run(fecha);

  res.json({ ok: true, actualizados: resultado.changes });
});

// ─── PANEL DE ASISTENCIA (sirve el HTML) ─────────────────────────────────────
app.get('/asistencia', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'asistencia.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
