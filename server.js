const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const { Pool } = require('pg');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Database ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.RAILWAY_ENVIRONMENT ? { rejectUnauthorized: false } : false
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS songs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      youtube TEXT DEFAULT '',
      category TEXT DEFAULT '',
      favorite BOOLEAN DEFAULT false,
      key_seconds INTEGER DEFAULT 0
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS requests (
      id SERIAL PRIMARY KEY,
      song TEXT NOT NULL,
      timestamp TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL DEFAULT '{}'
    )
  `);

  // Seed songs from songs.json if table is empty
  const { rows } = await pool.query('SELECT COUNT(*) FROM songs');
  if (parseInt(rows[0].count) === 0) {
    try {
      const seeds = JSON.parse(fs.readFileSync(path.join(__dirname, 'songs.json'), 'utf8'));
      for (const s of seeds) {
        await pool.query(
          'INSERT INTO songs (title, artist, youtube, category, favorite, key_seconds) VALUES ($1, $2, $3, $4, $5, $6)',
          [s.title, s.artist, s.youtube || '', s.category || '', !!s.favorite, s.key || 0]
        );
      }
      console.log(`  Seeded ${seeds.length} songs from songs.json`);
    } catch (e) {
      console.log('  No songs.json to seed from (or error reading it)');
    }
  }

  // Initialize state keys if missing
  await pool.query(`INSERT INTO app_state (key, value) VALUES ('queue', '[]') ON CONFLICT (key) DO NOTHING`);
  await pool.query(`INSERT INTO app_state (key, value) VALUES ('currentSong', 'null') ON CONFLICT (key) DO NOTHING`);
  await pool.query(`INSERT INTO app_state (key, value) VALUES ('qrVisible', 'false') ON CONFLICT (key) DO NOTHING`);
}

// --- State helpers ---
async function getState(key) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

async function setState(key, value) {
  await pool.query(
    'INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
    [key, JSON.stringify(value)]
  );
}

async function getFullState() {
  const queue = await getState('queue') || [];
  const currentSong = await getState('currentSong') || null;
  return { queue, currentSong };
}

// --- Helpers ---
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function songRow(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    youtube: row.youtube,
    category: row.category,
    favorite: row.favorite,
    key: row.key_seconds
  };
}

// --- Static files ---
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---
app.get('/api/songs', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM songs ORDER BY id');
  res.json(rows.map(songRow));
});

app.get('/api/ip', (_req, res) => res.json({ ip: getLocalIP(), port: PORT }));

app.post('/api/songs', async (req, res) => {
  const { title, artist, youtube, category, favorite, key } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });
  const { rows } = await pool.query(
    'INSERT INTO songs (title, artist, youtube, category, favorite, key_seconds) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
    [title, artist, youtube || '', category || '', !!favorite, parseInt(key) || 0]
  );
  res.json(songRow(rows[0]));
});

app.patch('/api/songs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const fields = [];
  const values = [];
  let i = 1;

  if (req.body.title !== undefined) { fields.push(`title = $${i++}`); values.push(req.body.title); }
  if (req.body.artist !== undefined) { fields.push(`artist = $${i++}`); values.push(req.body.artist); }
  if (req.body.youtube !== undefined) { fields.push(`youtube = $${i++}`); values.push(req.body.youtube); }
  if (req.body.category !== undefined) { fields.push(`category = $${i++}`); values.push(req.body.category); }
  if (req.body.favorite !== undefined) { fields.push(`favorite = $${i++}`); values.push(!!req.body.favorite); }
  if (req.body.key !== undefined) { fields.push(`key_seconds = $${i++}`); values.push(parseInt(req.body.key) || 0); }

  if (fields.length === 0) return res.status(400).json({ error: 'no fields to update' });

  values.push(id);
  const { rows } = await pool.query(
    `UPDATE songs SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`,
    values
  );
  if (rows.length === 0) return res.status(404).json({ error: 'song not found' });
  res.json(songRow(rows[0]));
});

app.delete('/api/songs/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { rowCount } = await pool.query('DELETE FROM songs WHERE id = $1', [id]);
  if (rowCount === 0) return res.status(404).json({ error: 'song not found' });
  res.json({ ok: true });
});

app.get('/api/requests', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM requests ORDER BY id');
  res.json(rows);
});

app.post('/api/requests', async (req, res) => {
  const { song } = req.body;
  if (!song) return res.status(400).json({ error: 'song required' });
  const { rows } = await pool.query(
    'INSERT INTO requests (song) VALUES ($1) RETURNING *',
    [song]
  );
  res.json(rows[0]);
});

// --- Socket.io ---
io.on('connection', async (socket) => {
  const state = await getFullState();
  socket.emit('state', state);
  socket.emit('qrVisible', await getState('qrVisible'));

  socket.on('setQrVisible', async (visible) => {
    await setState('qrVisible', !!visible);
    io.emit('qrVisible', !!visible);
  });

  socket.on('addToQueue', async ({ songId, name }) => {
    const { rows } = await pool.query('SELECT * FROM songs WHERE id = $1', [songId]);
    if (rows.length === 0) return;

    const queue = await getState('queue') || [];
    let currentSong = await getState('currentSong');

    const entry = { song: songRow(rows[0]), requestedBy: name, id: Date.now() };
    queue.push(entry);

    if (!currentSong) {
      currentSong = queue.shift();
    }

    await setState('queue', queue);
    await setState('currentSong', currentSong);
    io.emit('state', { queue, currentSong });
  });

  socket.on('nextSong', async () => {
    const queue = await getState('queue') || [];
    const currentSong = queue.length > 0 ? queue.shift() : null;
    await setState('queue', queue);
    await setState('currentSong', currentSong);
    io.emit('state', { queue, currentSong });
  });

  socket.on('removeSong', async (entryId) => {
    let queue = await getState('queue') || [];
    queue = queue.filter(e => e.id !== entryId);
    await setState('queue', queue);
    const currentSong = await getState('currentSong');
    io.emit('state', { queue, currentSong });
  });

  socket.on('clearQueue', async () => {
    await setState('queue', []);
    await setState('currentSong', null);
    io.emit('state', { queue: [], currentSong: null });
  });
});

// --- Start ---
initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    const ip = getLocalIP();
    console.log('');
    console.log('  🎤 Ofir\'s Karaoke Server is running!');
    console.log('');
    console.log(`  Display (open on TV):  http://localhost:${PORT}`);
    console.log(`  Join (for phones):     http://${ip}:${PORT}/join.html`);
    console.log(`  Request songs:         http://${ip}:${PORT}/request.html`);
    console.log(`  Admin dashboard:       http://localhost:${PORT}/dashboard.html`);
    console.log('');
  });
}).catch(err => {
  console.error('Failed to initialize database:', err.message);
  process.exit(1);
});
