const express = require('express');
const Database = require('better-sqlite3');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// DB — se guarda en /data (Volume persistente de Railway)
// Si /data no existe (entorno local), cae a src/../data/
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, '../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const dbPath = path.join(DATA_DIR, 'kine.db');
console.log(`📦 Base de datos en: ${dbPath}`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre TEXT NOT NULL,
    edad INTEGER,
    objetivo TEXT,
    lesiones TEXT,
    notas TEXT,
    creado_en TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS rutinas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL,
    nombre TEXT NOT NULL,
    fecha TEXT NOT NULL,
    sesiones TEXT NOT NULL,
    creado_en TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY(paciente_id) REFERENCES pacientes(id)
  );

  CREATE TABLE IF NOT EXISTS cargas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paciente_id INTEGER NOT NULL,
    ejercicio TEXT NOT NULL,
    fecha TEXT NOT NULL,
    kg REAL,
    reps TEXT,
    rir TEXT,
    notas TEXT,
    FOREIGN KEY(paciente_id) REFERENCES pacientes(id)
  );
`);

app.use(express.json());
app.use(cookieParser());
// Servir estáticos con revalidación obligatoria: el navegador puede cachear,
// pero SIEMPRE chequea con el server si cambió antes de usar la copia (evita servir JS/HTML viejo).
app.use(express.static(path.join(__dirname, '../public'), {
  etag: true,
  lastModified: true,
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-cache'); }
}));

// ── PACIENTES ─────────────────────────────────────────────────────────────────
app.get('/api/pacientes', (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, 
      COUNT(DISTINCT r.id) as total_rutinas,
      MAX(r.fecha) as ultima_rutina
    FROM pacientes p
    LEFT JOIN rutinas r ON r.paciente_id = p.id
    GROUP BY p.id
    ORDER BY p.nombre
  `).all();
  res.json(rows);
});

app.post('/api/pacientes', (req, res) => {
  const { nombre, edad, objetivo, lesiones, notas } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Nombre requerido' });
  const r = db.prepare(
    'INSERT INTO pacientes (nombre, edad, objetivo, lesiones, notas) VALUES (?,?,?,?,?)'
  ).run(nombre, edad||null, objetivo||'', lesiones||'', notas||'');
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/pacientes/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM pacientes WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'No encontrado' });
  res.json(p);
});

app.put('/api/pacientes/:id', (req, res) => {
  const { nombre, edad, objetivo, lesiones, notas } = req.body;
  db.prepare(
    'UPDATE pacientes SET nombre=?, edad=?, objetivo=?, lesiones=?, notas=? WHERE id=?'
  ).run(nombre, edad||null, objetivo||'', lesiones||'', notas||'', req.params.id);
  res.json({ ok: true });
});

app.delete('/api/pacientes/:id', (req, res) => {
  db.prepare('DELETE FROM rutinas WHERE paciente_id = ?').run(req.params.id);
  db.prepare('DELETE FROM cargas WHERE paciente_id = ?').run(req.params.id);
  db.prepare('DELETE FROM pacientes WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── RUTINAS ───────────────────────────────────────────────────────────────────
app.get('/api/pacientes/:id/rutinas', (req, res) => {
  const rows = db.prepare(
    'SELECT id, nombre, fecha, creado_en FROM rutinas WHERE paciente_id = ? ORDER BY fecha DESC'
  ).all(req.params.id);
  res.json(rows);
});

app.post('/api/pacientes/:id/rutinas', (req, res) => {
  const { nombre, fecha } = req.body;
  // El app.js guarda como "días" (con tilde), el server como "sesiones"
  const datos = req.body.sesiones || req.body['días'] || req.body.dias || [];
  const r = db.prepare(
    'INSERT INTO rutinas (paciente_id, nombre, fecha, sesiones) VALUES (?,?,?,?)'
  ).run(req.params.id, nombre, fecha, JSON.stringify(datos));
  res.json({ id: r.lastInsertRowid });
});

app.get('/api/rutinas/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM rutinas WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'No encontrada' });
  r.sesiones = JSON.parse(r.sesiones);
  res.json(r);
});

app.put('/api/rutinas/:id', (req, res) => {
  const { nombre, fecha } = req.body;
  const datos = req.body.sesiones || req.body['días'] || req.body.dias || [];
  db.prepare('UPDATE rutinas SET nombre=?, fecha=?, sesiones=? WHERE id=?')
    .run(nombre, fecha, JSON.stringify(datos), req.params.id);
  res.json({ ok: true });
});

app.delete('/api/rutinas/:id', (req, res) => {
  db.prepare('DELETE FROM rutinas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── CARGAS ────────────────────────────────────────────────────────────────────
app.get('/api/pacientes/:id/cargas', (req, res) => {
  const { ejercicio } = req.query;
  let q = 'SELECT * FROM cargas WHERE paciente_id = ?';
  const params = [req.params.id];
  if (ejercicio) { q += ' AND ejercicio = ?'; params.push(ejercicio); }
  q += ' ORDER BY fecha ASC';
  res.json(db.prepare(q).all(...params));
});

app.post('/api/pacientes/:id/cargas', (req, res) => {
  const { ejercicio, fecha, kg, reps, rir, notas } = req.body;
  const r = db.prepare(
    'INSERT INTO cargas (paciente_id, ejercicio, fecha, kg, reps, rir, notas) VALUES (?,?,?,?,?,?,?)'
  ).run(req.params.id, ejercicio, fecha, kg||null, reps||'', rir||'', notas||'');
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/cargas/:id', (req, res) => {
  db.prepare('DELETE FROM cargas WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/pacientes/:id/ejercicios-con-cargas', (req, res) => {
  const rows = db.prepare(
    'SELECT DISTINCT ejercicio FROM cargas WHERE paciente_id = ? ORDER BY ejercicio'
  ).all(req.params.id);
  res.json(rows.map(r => r.ejercicio));
});


app.listen(PORT, () => console.log(`KineApp corriendo en puerto ${PORT}`));
