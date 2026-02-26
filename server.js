const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// --- Dynamic song loading (no restart needed) ---
const SONGS_FILE = path.join(__dirname, 'songs.json');

function loadSongs() {
  try {
    return JSON.parse(fs.readFileSync(SONGS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveSongs(songs) {
  fs.writeFileSync(SONGS_FILE, JSON.stringify(songs, null, 2));
}

// --- Requests persistence ---
const REQUESTS_FILE = path.join(__dirname, 'requests.json');

function loadRequests() {
  try {
    return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveRequests(requests) {
  fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
}

// --- File-based persistence ---
const STATE_FILE = path.join(__dirname, 'state.json');
let queue = [];
let currentSong = null;

function loadState() {
  try {
    const data = fs.readFileSync(STATE_FILE, 'utf8');
    const state = JSON.parse(data);
    queue = state.queue || [];
    currentSong = state.currentSong || null;
  } catch {
    queue = [];
    currentSong = null;
  }
}

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ queue, currentSong }, null, 2));
}

loadState();

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

// --- Static files ---
const PORT = process.env.PORT || 3000;
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- API ---
app.get('/api/songs', (_req, res) => res.json(loadSongs()));
app.get('/api/ip', (_req, res) => res.json({ ip: getLocalIP(), port: PORT }));

app.post('/api/songs', (req, res) => {
  const { title, artist, youtube, category, favorite, key } = req.body;
  if (!title || !artist) return res.status(400).json({ error: 'title and artist required' });
  const songs = loadSongs();
  const maxId = songs.reduce((max, s) => Math.max(max, s.id), 0);
  const newSong = { id: maxId + 1, title, artist, youtube: youtube || '', category: category || '', favorite: !!favorite, key: parseInt(key) || 0 };
  songs.push(newSong);
  saveSongs(songs);
  res.json(newSong);
});

app.patch('/api/songs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const songs = loadSongs();
  const song = songs.find(s => s.id === id);
  if (!song) return res.status(404).json({ error: 'song not found' });
  Object.assign(song, req.body);
  saveSongs(songs);
  res.json(song);
});

app.delete('/api/songs/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  let songs = loadSongs();
  const before = songs.length;
  songs = songs.filter(s => s.id !== id);
  if (songs.length === before) return res.status(404).json({ error: 'song not found' });
  saveSongs(songs);
  res.json({ ok: true });
});

app.get('/api/requests', (_req, res) => res.json(loadRequests()));

app.post('/api/requests', (req, res) => {
  const { song } = req.body;
  if (!song) return res.status(400).json({ error: 'song required' });
  const requests = loadRequests();
  const entry = { id: Date.now(), song, timestamp: new Date().toISOString() };
  requests.push(entry);
  saveRequests(requests);
  res.json(entry);
});

// --- Socket.io ---
io.on('connection', (socket) => {
  socket.emit('state', { queue, currentSong });

  socket.on('addToQueue', ({ songId, name }) => {
    const song = loadSongs().find(s => s.id === songId);
    if (!song) return;

    const entry = { song, requestedBy: name, id: Date.now() };
    queue.push(entry);

    if (!currentSong) {
      currentSong = queue.shift();
    }

    saveState();
    io.emit('state', { queue, currentSong });
  });

  socket.on('nextSong', () => {
    currentSong = queue.length > 0 ? queue.shift() : null;
    saveState();
    io.emit('state', { queue, currentSong });
  });

  socket.on('removeSong', (entryId) => {
    queue = queue.filter(e => e.id !== entryId);
    saveState();
    io.emit('state', { queue, currentSong });
  });

  socket.on('clearQueue', () => {
    queue = [];
    currentSong = null;
    saveState();
    io.emit('state', { queue, currentSong });
  });
});

// --- Start ---
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
