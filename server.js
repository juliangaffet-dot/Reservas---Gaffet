const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIGURACIÓN GOOGLE CALENDAR ───────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const REFRESH_TOKEN_MAURO = process.env.GOOGLE_REFRESH_TOKEN_MAURO;
const REFRESH_TOKEN_ESTEBAN = process.env.GOOGLE_REFRESH_TOKEN_ESTEBAN;
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

// Paso 1: ruta para autorizar (solo la usás una vez para obtener el refresh token)
app.get('/auth', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
  });
  res.redirect(url);
});

// Paso 2: callback de Google (solo una vez)
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens } = await oauth2Client.getToken(code);
  console.log('\n✅ REFRESH TOKEN OBTENIDO:\n', tokens.refresh_token);
  console.log('\nCopiá ese refresh_token y pegalo como variable de entorno GOOGLE_REFRESH_TOKEN\n');
  res.send('<h2>✅ Autorización exitosa!</h2><p>Copiá el refresh_token de la consola y configuralo como variable de entorno.</p>');
});

// ─── RUTA PRINCIPAL: crear reserva ───────────────────────────────────────────
app.post('/api/reservar', async (req, res) => {
  try {
    const { nombre, email, telefono, fecha, hora, acompanante } = req.body;

    if (!nombre || !email || !fecha || !hora) {
      return res.status(400).json({ error: 'Faltan datos obligatorios' });
    }

    const prof = PROFESIONALES[req.body.profesional] || PROFESIONALES.julian;
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // Construir fecha/hora en zona horaria de Salta
    const [year, month, day] = fecha.split('-').map(Number);
    const [startHour, startMin] = hora.split(':').map(Number);
    const endHour = startHour + 1;

    const startTime = `${fecha}T${String(startHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;
    const endTime   = `${fecha}T${String(endHour).padStart(2,'0')}:${String(startMin).padStart(2,'0')}:00-03:00`;

    let descripcion = `Paciente: ${nombre}\nTeléfono: ${telefono}\nEmail: ${email}`;
    if (acompanante) descripcion += `\nAcompañante: ${acompanante}`;

    let titulo = `Turno - ${nombre}`;
    if (acompanante) titulo += ` + ${acompanante}`;

    const attendees = [{ email }];

    const event = {
      summary: titulo,
      location: 'Cmte. Piedrabuena 820, A4400 Salta, Argentina',
      description: descripcion,
      start: { dateTime: startTime, timeZone: 'America/Argentina/Salta' },
      end:   { dateTime: endTime,   timeZone: 'America/Argentina/Salta' },
      attendees,
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 30 },
          { method: 'popup',  minutes: 30 },
        ],
      },
      sendUpdates: 'all', // envía invitación por email al paciente
    };

    const response = await calendar.events.insert({
      calendarId: prof.calendarId || 'primary',
      resource: event,
      sendNotifications: true,
    });

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

    const prof = PROFESIONALES[req.body.profesional] || PROFESIONALES.julian;
    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const timeMin = `${fecha}T00:00:00-03:00`;
    const timeMax = `${fecha}T23:59:59-03:00`;

    const response = await calendar.events.list({
      calendarId: prof.calendarId || 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    const cupos = {};
    const bloqueados = {}; // horarios completamente bloqueados

    const PALABRAS_BLOQUEO = ['bloqueado', 'no disponible', 'feriado', 'cerrado', 'ocupado', 'no atiende'];

    // Generar todos los slots posibles del día (cada 30 min de 06:00 a 23:30)
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

      // Evento de día completo — bloquea todo el día
      if (ev.start?.date && !ev.start?.dateTime && esBloqueo) {
        bloqueados['DIA_COMPLETO'] = true;
        return;
      }

      if (!ev.start?.dateTime) return;

      const horaInicio = ev.start.dateTime.substring(11, 16); // "HH:MM"
      const horaFin = ev.end?.dateTime ? ev.end.dateTime.substring(11, 16) : horaInicio;

      if (esBloqueo) {
        // Bloquear todos los slots de 30 min dentro del rango del evento
        const inicioMins = timeToMinutes(horaInicio);
        const finMins = timeToMinutes(horaFin);
        for (let m = inicioMins; m < finMins; m += 30) {
          cupos[minutesToTime(m)] = 999;
        }
      } else {
        cupos[horaInicio] = (cupos[horaInicio] || 0) + 1;
      }
    });

    // Si el día completo está bloqueado, devolver señal especial
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
