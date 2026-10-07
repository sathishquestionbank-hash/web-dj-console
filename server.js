const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  transports: ['websocket', 'polling']
});

const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'deckmaster2026';
const MAX_ADMINS = 2;

// Storage configuration for uploaded audio tracks
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${Date.now()}-${cleanName}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 40 * 1024 * 1024 } // 40MB limit
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Global DJ Deck Playback State
const djState = {
  crossfader: 0.5, // 0 = Deck A fully, 1 = Deck B fully
  deckA: {
    trackName: 'Built-in Synth Groove A',
    trackUrl: null, // null triggers built-in synthesized buffer
    isPlaying: false,
    serverStartTime: 0,
    audioOffset: 0,
    playbackRate: 1.0,
    loop: true,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    volume: 0.85
  },
  deckB: {
    trackName: 'Built-in Bass Funk B',
    trackUrl: null,
    isPlaying: false,
    serverStartTime: 0,
    audioOffset: 0,
    playbackRate: 1.0,
    loop: true,
    eqLow: 0,
    eqMid: 0,
    eqHigh: 0,
    volume: 0.85
  }
};

// Admin session tracking (hard capped at 2)
const activeAdmins = new Set();

// Audio File Upload Route
app.post('/api/upload', upload.single('audio'), (req, res) => {
  const authHeader = req.headers['x-admin-token'];
  if (authHeader !== ADMIN_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No audio file uploaded.' });
  }

  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    success: true,
    url: fileUrl,
    filename: req.file.originalname
  });
});

// Broadcast admin count updates
function broadcastAdminCount() {
  io.emit('admin:count', {
    activeAdmins: activeAdmins.size,
    maxAdmins: MAX_ADMINS
  });
}

io.on('connection', (socket) => {
  let isAdmin = false;

  // 1. NTP-style Clock Synchronization handshake
  // High-frequency ping-pong for calculating client-server clock offset
  socket.on('ntp:ping', (data) => {
    socket.emit('ntp:pong', {
      clientTimestamp: data.clientTimestamp,
      serverTimestamp: Date.now()
    });
  });

  // 2. Initial State sync
  socket.emit('sync:state', djState);
  socket.emit('admin:count', {
    activeAdmins: activeAdmins.size,
    maxAdmins: MAX_ADMINS
  });

  // 3. Admin Authentication
  socket.on('admin:auth', (password, callback) => {
    if (typeof callback !== 'function') return;

    if (password !== ADMIN_PASSWORD) {
      return callback({ success: false, message: 'Invalid Admin Password.' });
    }

    if (activeAdmins.size >= MAX_ADMINS && !activeAdmins.has(socket.id)) {
      return callback({
        success: false,
        message: `Admin cap reached (${MAX_ADMINS}/${MAX_ADMINS} sessions active).`
      });
    }

    isAdmin = true;
    activeAdmins.add(socket.id);
    broadcastAdminCount();
    callback({ success: true, message: 'Admin access granted.' });
  });

  // 4. Admin Deck Operations (Require Admin Role)
  socket.on('dj:play', ({ deck, audioOffset }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    // Schedule play event ~250ms into the future to compensate for packet flight
    const scheduleLeadTimeMs = 250;
    targetDeck.isPlaying = true;
    targetDeck.audioOffset = audioOffset;
    targetDeck.serverStartTime = Date.now() + scheduleLeadTimeMs;

    io.emit('sync:play', {
      deck,
      serverStartTime: targetDeck.serverStartTime,
      audioOffset: targetDeck.audioOffset,
      playbackRate: targetDeck.playbackRate
    });
  });

  socket.on('dj:pause', ({ deck, currentOffset }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    targetDeck.isPlaying = false;
    targetDeck.audioOffset = currentOffset;

    io.emit('sync:pause', {
      deck,
      audioOffset: targetDeck.audioOffset
    });
  });

  socket.on('dj:seek', ({ deck, seekOffset }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    const scheduleLeadTimeMs = 200;
    targetDeck.audioOffset = seekOffset;
    if (targetDeck.isPlaying) {
      targetDeck.serverStartTime = Date.now() + scheduleLeadTimeMs;
    }

    io.emit('sync:seek', {
      deck,
      isPlaying: targetDeck.isPlaying,
      serverStartTime: targetDeck.serverStartTime,
      audioOffset: targetDeck.audioOffset
    });
  });

  socket.on('dj:rate', ({ deck, rate }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    targetDeck.playbackRate = rate;
    io.emit('sync:rate', { deck, rate });
  });

  socket.on('dj:loop', ({ deck, loop }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    targetDeck.loop = loop;
    io.emit('sync:loop', { deck, loop });
  });

  socket.on('dj:eq', ({ deck, band, value }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    if (band === 'low') targetDeck.eqLow = value;
    if (band === 'mid') targetDeck.eqMid = value;
    if (band === 'high') targetDeck.eqHigh = value;

    io.emit('sync:eq', { deck, band, value });
  });

  socket.on('dj:volume', ({ deck, volume }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    targetDeck.volume = volume;
    io.emit('sync:volume', { deck, volume });
  });

  socket.on('dj:crossfader', ({ value }) => {
    if (!isAdmin) return;
    djState.crossfader = value;
    io.emit('sync:crossfader', { value });
  });

  socket.on('dj:loadTrack', ({ deck, trackUrl, trackName }) => {
    if (!isAdmin) return;
    const targetDeck = djState[deck];
    if (!targetDeck) return;

    targetDeck.trackUrl = trackUrl;
    targetDeck.trackName = trackName;
    targetDeck.isPlaying = false;
    targetDeck.audioOffset = 0;

    io.emit('sync:loadTrack', { deck, trackUrl, trackName });
  });

  // Handle Disconnection
  socket.on('disconnect', () => {
    if (isAdmin) {
      activeAdmins.delete(socket.id);
      broadcastAdminCount();
    }
  });
});

server.listen(PORT, () => {
  console.log(`[Audio-Server] Running on port ${PORT}`);
});