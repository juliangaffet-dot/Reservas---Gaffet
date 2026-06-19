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
// Se guarda en /data (Volume persistente de Railway) para que sobreviva a cada deploy.
// Si /data no existe (ej. corriendo local), cae de nuevo a la carpeta del proyecto.
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

// Migración suave: agregar columnas si la DB ya existía sin ellas
try { db.exec(`ALTER TABLE pacientes ADD COLUMN email TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN telefono TEXT`); } catch(e) {}
try { db.exec(`ALTER TABLE pacientes ADD COLUMN sin_completar INTEGER NOT NULL DEFAULT 1`); } catch(e) {}
// ─────────────────────────────────────────────────────────────────────────────

// ─── CONFIGURACIÓN ────────────────────────────────────────────────────────────
const CLIENT_ID      = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET  = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI   = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const REFRESH_TOKEN  = process.env.GOOGLE_REFRESH_TOKEN;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || 'kinehouse2025';

const PROFESIONALES = {
  julian:  { nombre: 'Lic. Julián Gaffet',  mp: '1321', calendarId: 'primary' },
  mauro:   { nombre: 'Lic. Mauro Ayub',     mp: '1263', calendarId: 'mauroayub@gmail.com' },
  esteban: { nombre: 'Lic. Esteban Videla', mp: '1337', calendarId: 'tebyvidela@gmail.com' }
};

const PALABRAS_BLOQUEO = ['bloqueado', 'no disponible', 'feriado', 'cerrado', 'ocupado', 'no atiende'];

// ─── AUTO-REGISTRO DE PACIENTES ──────────────────────────────────────────────
// Si el paciente no existe (por nombre+profesional), lo crea con valores por defecto.
// Julián completa después obra social y sesiones reales desde el panel.
function obtenerOCrearPaciente(nombre, profesional, email, telefono) {
  const existente = db.prepare(`
    SELECT id FROM pacientes WHERE LOWER(nombre) = LOWER(?) AND profesional = ? AND activo = 1 LIMIT 1
  `).get(nombre, profesional);
  if (existente) {
    // Si ya existe pero no tenía email/telefono, completarlos
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
// ─────────────────────────────────────────────────────────────────────────────

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
// ─────────────────────────────────────────────────────────────────────────────

// ─── JOB AUTOMÁTICO 21hs ─────────────────────────────────────────────────────
function getHoraArgentina() {
  const arg = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  return { hora: arg.getUTCHours(), minuto: arg.getUTCMinutes() };
}
function getFechaArgentina() {
  const arg = new Date(new Date().getTime() - 3 * 60 * 60 * 1000);
  return arg.toISOString().substring(0, 10);
}

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
// ─────────────────────────────────────────────────────────────────────────────

// ─── AUTH GOOGLE ──────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/calendar'] });
  res.redirect(url);
});
app.get('/auth/callback', async (req, res) => {
  const { tokens } = await oauth2Client.getToken(req.query.code);
  console.log('\n✅ REFRESH TOKEN:\n', tokens.refresh_token);
  res.send('<h2>✅ Autorización exitosa!</h2>');
});
// ─────────────────────────────────────────────────────────────────────────────

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

    const pacienteId = obtenerOCrearPaciente(nombre, profId, email, telefono);
    db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id) VALUES (?, ?, ?, ?, ?, ?, ?, 'pendiente', ?)`).run(nombre, email||'', telefono||'', acompanante||'', profId, fecha, hora, pacienteId);

    if (acompanante) {
      const pacAcompId = obtenerOCrearPaciente(acompanante, profId, '', '');
      db.prepare(`INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id) VALUES (?, '', '', '', ?, ?, ?, 'pendiente', ?)`).run(acompanante, profId, fecha, hora, pacAcompId);
    }

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

// ─── SINCRONIZAR CON GOOGLE CALENDAR ─────────────────────────────────────────
app.post('/api/sincronizar', authPanel, async (req, res) => {
  try {
    const { fecha, profesional } = req.body;
    if (!fecha || !profesional) return res.status(400).json({ error: 'Faltan datos' });

    // Si profesional es 'todos', sincronizar los tres
    const profsASincronizar = profesional === 'todos'
      ? Object.keys(PROFESIONALES)
      : [profesional];

    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    let agregados = 0;
    let eliminados = 0;

    for (const profId of profsASincronizar) {
      const prof = PROFESIONALES[profId];

      // 1. Obtener eventos reales del calendario
      const response = await calendar.events.list({
        calendarId: prof.calendarId,
        timeMin: `${fecha}T00:00:00-03:00`,
        timeMax: `${fecha}T23:59:59-03:00`,
        singleEvents: true,
        orderBy: 'startTime',
      });

      const eventos = (response.data.items || []).filter(ev => {
        if (!ev.start?.dateTime) return false;
        const titulo = (ev.summary || '').toLowerCase();
        return !PALABRAS_BLOQUEO.some(p => titulo.includes(p));
      });

      // 2. Construir lista de nombres+horas reales del calendario
      const eventosReales = eventos.map(ev => {
        const titulo = ev.summary || '';
        const hora = ev.start.dateTime.substring(11, 16);
        // Extraer nombre: "Turno - Nombre Apellido" → "Nombre Apellido"
        const nombre = titulo.replace(/^turno\s*[-–]\s*/i, '').trim();
        return { nombre, hora };
      });

      // 3. Obtener turnos actuales en DB para ese día y profesional
      const turnosDB = db.prepare(`SELECT * FROM turnos WHERE fecha = ? AND profesional = ?`).all(fecha, profId);

      // 4. Eliminar de DB los turnos que ya no están en el calendario
      //    (solo los que están en estado 'pendiente' para no borrar asistencias ya marcadas)
      for (const turno of turnosDB) {
        if (turno.estado !== 'pendiente') continue;
        const estaEnCalendario = eventosReales.some(ev =>
          ev.hora === turno.hora &&
          ev.nombre.toLowerCase() === turno.nombre.toLowerCase()
        );
        if (!estaEnCalendario) {
          db.prepare(`DELETE FROM turnos WHERE id = ?`).run(turno.id);
          eliminados++;
        }
      }

      // 5. Agregar a DB los eventos del calendario que no están en la DB
      for (const ev of eventosReales) {
        // Si el nombre tiene " + " puede ser que tenga acompañante
        const nombres = ev.nombre.includes(' + ')
          ? ev.nombre.split(' + ').map(n => n.trim())
          : [ev.nombre];

        for (const nombre of nombres) {
          const yaExiste = db.prepare(`
            SELECT id FROM turnos WHERE fecha = ? AND profesional = ? AND hora = ? AND LOWER(nombre) = LOWER(?)
          `).get(fecha, profId, ev.hora, nombre);

          if (!yaExiste) {
            const pacienteId = obtenerOCrearPaciente(nombre, profId, '', '');
            db.prepare(`
              INSERT INTO turnos (nombre, email, telefono, acompanante, profesional, fecha, hora, estado, paciente_id)
              VALUES (?, '', '', '', ?, ?, ?, 'pendiente', ?)
            `).run(nombre, profId, fecha, ev.hora, pacienteId);
            agregados++;
          }
        }
      }
    }

    res.json({ ok: true, agregados, eliminados });
  } catch (err) {
    console.error('Error sincronizar:', err.message);
    res.status(500).json({ error: 'No se pudo sincronizar con Google Calendar' });
  }
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
  db.prepare(`UPDATE pacientes SET nombre=?, obra_social=?, plan=?, sesiones_total=?, sesiones_usadas=?, profesional=?, activo=?, sin_completar=? WHERE id=?`).run(
    nombre??p.nombre, obra_social??p.obra_social, plan??p.plan,
    sesiones_total??p.sesiones_total, sesiones_usadas??p.sesiones_usadas,
    profesional??p.profesional, activo??p.activo, sinCompletar, req.params.id
  );
  res.json({ ok: true });
});

app.delete('/api/pacientes/:id', authPanel, (req, res) => {
  db.prepare('UPDATE pacientes SET activo = 0 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
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
      if (estado === 'asistio' && turno.estado !== 'asistio')
        db.prepare('UPDATE pacientes SET sesiones_usadas = sesiones_usadas + 1 WHERE id = ? AND sesiones_usadas < sesiones_total').run(turno.paciente_id);
      if (turno.estado === 'asistio' && estado !== 'asistio')
        db.prepare('UPDATE pacientes SET sesiones_usadas = MAX(0, sesiones_usadas - 1) WHERE id = ?').run(turno.paciente_id);
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

app.get('/asistencia', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'asistencia.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
