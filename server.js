const express = require('express');
const { google } = require('googleapis');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ─── CONFIGURACIÓN GOOGLE CALENDAR ───────────────────────────────────────────
// Reemplazá estos valores con los tuyos de Google Cloud Console
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI  = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';
const REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
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
      calendarId: 'primary',
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

    oauth2Client.setCredentials({ refresh_token: REFRESH_TOKEN });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const timeMin = `${fecha}T00:00:00-03:00`;
    const timeMax = `${fecha}T23:59:59-03:00`;

    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
    });

    const eventos = response.data.items || [];
    const cupos = {};

    eventos.forEach(ev => {
      if (!ev.start?.dateTime) return;
      const hora = ev.start.dateTime.substring(11, 16); // "HH:MM"
      cupos[hora] = (cupos[hora] || 0) + 1;
    });

    res.json({ cupos });

  } catch (err) {
    console.error('Error obteniendo cupos:', err.message);
    res.status(500).json({ error: 'No se pudieron obtener los cupos' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Servidor corriendo en http://localhost:${PORT}`));
