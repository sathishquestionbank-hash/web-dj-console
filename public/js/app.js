/**
 * SoundPulse Sync - Main Application Orchestrator
 * Connects Web Audio DSP, NTP Sync Engine, Socket.IO Events, and DJ Console UI
 */
document.addEventListener('DOMContentLoaded', () => {
  const socket = io({ transports: ['websocket', 'polling'] });
  const syncEngine = new SyncEngine(socket);
  const djConsole = new DJConsole(syncEngine);

  let isAdminRole = false;
  let adminAuthToken = null;

  // --- UI References ---
  const unlockOverlay = document.getElementById('unlockOverlay');
  const btnUnlock = document.getElementById('btnUnlock');
  const adminModal = document.getElementById('adminModal');
  const btnOpenAdminModal = document.getElementById('btnOpenAdminModal');
  const btnCancelAdmin = document.getElementById('btnCancelAdmin');
  const btnSubmitAdmin = document.getElementById('btnSubmitAdmin');
  const adminPasswordInput = document.getElementById('adminPasswordInput');
  const adminErrorMsg = document.getElementById('adminErrorMsg');
  const userRoleBadge = document.getElementById('userRoleBadge');

  const metricOffset = document.getElementById('metricOffset');
  const metricRtt = document.getElementById('metricRtt');
  const metricAdmins = document.getElementById('metricAdmins');

  const masterCrossfader = document.getElementById('masterCrossfader');
  const visualizerCanvas = document.getElementById('masterVisualizerCanvas');
  const canvasCtx = visualizerCanvas.getContext('2d');
  const vuA = document.getElementById('vuA');
  const vuB = document.getElementById('vuB');

  // --- 1. Autoplay Unlock Handler ---
  btnUnlock.addEventListener('click', async () => {
    try {
      await syncEngine.initAudioContext();
      djConsole.setupAudioGraph();
      syncEngine.startClockSync();
      unlockOverlay.classList.add('hidden');
      startVisualizerLoop();
    } catch (err) {
      console.error('AudioContext initialization failed:', err);
    }
  });

  // --- 2. Precision NTP Time Sync Callbacks ---
  syncEngine.onOffsetUpdated = (offset, rtt) => {
    metricOffset.textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms`;
    metricRtt.textContent = `${rtt.toFixed(1)} ms`;
  };

  // --- 3. Admin Authentication Modal & Hard-Cap Handling ---
  btnOpenAdminModal.addEventListener('click', () => {
    adminErrorMsg.textContent = '';
    adminPasswordInput.value = '';
    adminModal.classList.remove('hidden');
    adminPasswordInput.focus();
  });

  btnCancelAdmin.addEventListener('click', () => {
    adminModal.classList.add('hidden');
  });

  adminPasswordInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      btnSubmitAdmin.click();
    }
  });

  btnSubmitAdmin.addEventListener('click', () => {
    const password = adminPasswordInput.value.trim();
    if (!password) {
      adminErrorMsg.textContent = 'Please enter a password.';
      return;
    }

    socket.emit('admin:auth', password, (response) => {
      if (response && response.success) {
        isAdminRole = true;
        adminAuthToken = password;

        document.body.classList.remove('role-listener');
        document.body.classList.add('role-admin');

        userRoleBadge.textContent = 'DJ ADMIN';
        userRoleBadge.className = 'badge badge-admin';
        btnOpenAdminModal.style.display = 'none';
        adminModal.classList.add('hidden');
      } else {
        adminErrorMsg.textContent = (response && response.message) || 'Authentication failed.';
      }
    });
  });

  // --- 4. Global Broadcast Listeners ---
  socket.on('admin:count', ({ activeAdmins, maxAdmins }) => {
    metricAdmins.textContent = `${activeAdmins} / ${maxAdmins}`;
  });

  socket.on('sync:state', (state) => {
    masterCrossfader.value = state.crossfader;
    djConsole.setCrossfader(state.crossfader);

    ['deckA', 'deckB'].forEach((deckKey) => {
      const deckState = state[deckKey];
      document.getElementById(`${deckKey}_title`).textContent = deckState.trackName;
      document.getElementById(`${deckKey}_pitch`).value = deckState.playbackRate;
      document.getElementById(`${deckKey}_pitch_val`).textContent = `${deckState.playbackRate.toFixed(2)}x`;
      document.getElementById(`${deckKey}_vol`).value = deckState.volume;
      document.getElementById(`${deckKey}_vol_val`).textContent = `${Math.round(deckState.volume * 100)}%`;

      djConsole.setEQ(deckKey, 'low', deckState.eqLow);
      djConsole.setEQ(deckKey, 'mid', deckState.eqMid);
      djConsole.setEQ(deckKey, 'high', deckState.eqHigh);
      djConsole.setVolume(deckKey, deckState.volume);
      djConsole.setPlaybackRate(deckKey, deckState.playbackRate);
      djConsole.setLoop(deckKey, deckState.loop);

      const loopBtn = document.getElementById(`${deckKey}_loop`);
      loopBtn.textContent = `LOOP: ${deckState.loop ? 'ON' : 'OFF'}`;
      loopBtn.classList.toggle('active', deckState.loop);

      if (deckState.isPlaying) {
        djConsole.play(deckKey, deckState.serverStartTime, deckState.audioOffset, deckState.playbackRate);
        updatePlayPauseUI(deckKey, true);
      } else {
        updatePlayPauseUI(deckKey, false);
      }
    });
  });

  socket.on('sync:play', ({ deck, serverStartTime, audioOffset, playbackRate }) => {
    djConsole.play(deck, serverStartTime, audioOffset, playbackRate);
    updatePlayPauseUI(deck, true);
  });

  socket.on('sync:pause', ({ deck, audioOffset }) => {
    djConsole.pause(deck, audioOffset);
    updatePlayPauseUI(deck, false);
  });

  socket.on('sync:seek', ({ deck, isPlaying, serverStartTime, audioOffset }) => {
    if (isPlaying) {
      djConsole.play(deck, serverStartTime, audioOffset, djConsole.decks[deck].playbackRate);
      updatePlayPauseUI(deck, true);
    } else {
      djConsole.pause(deck, audioOffset);
      updatePlayPauseUI(deck, false);
    }
  });

  socket.on('sync:rate', ({ deck, rate }) => {
    djConsole.setPlaybackRate(deck, rate);
    document.getElementById(`${deck}_pitch`).value = rate;
    document.getElementById(`${deck}_pitch_val`).textContent = `${rate.toFixed(2)}x`;
  });

  socket.on('sync:loop', ({ deck, loop }) => {
    djConsole.setLoop(deck, loop);
    const loopBtn = document.getElementById(`${deck}_loop`);
    loopBtn.textContent = `LOOP: ${loop ? 'ON' : 'OFF'}`;
    loopBtn.classList.toggle('active', loop);
  });

  socket.on('sync:eq', ({ deck, band, value }) => {
    djConsole.setEQ(deck, band, value);
    const capBand = band.charAt(0).toUpperCase() + band.slice(1);
    document.getElementById(`${deck}_eq${capBand}`).value = value;
    document.getElementById(`${deck}_eq${capBand}_val`).textContent = `${value}dB`;
  });

  socket.on('sync:volume', ({ deck, volume }) => {
    djConsole.setVolume(deck, volume);
    document.getElementById(`${deck}_vol`).value = volume;
    document.getElementById(`${deck}_vol_val`).textContent = `${Math.round(volume * 100)}%`;
  });

  socket.on('sync:crossfader', ({ value }) => {
    masterCrossfader.value = value;
    djConsole.setCrossfader(value);
  });

  socket.on('sync:loadTrack', async ({ deck, trackUrl, trackName }) => {
    document.getElementById(`${deck}_title`).textContent = trackName;
    if (trackUrl) {
      await djConsole.loadAudioFile(deck, trackUrl);
    } else {
      if (deck === 'deckA') djConsole.decks.deckA.buffer = djConsole.generateSynthTrackA();
      if (deck === 'deckB') djConsole.decks.deckB.buffer = djConsole.generateSynthTrackB();
      djConsole.decks[deck].duration = djConsole.decks[deck].buffer.duration;
      djConsole.decks[deck].audioOffset = 0;
    }
    updatePlayPauseUI(deck, false);
  });

  // --- 5. Interactive DJ Deck Bindings (Admin Triggers) ---
  function bindDeckEvents(deckKey) {
    const playBtn = document.getElementById(`${deckKey}_play`);
    const pauseBtn = document.getElementById(`${deckKey}_pause`);
    const cueBtn = document.getElementById(`${deckKey}_cue`);
    const loopBtn = document.getElementById(`${deckKey}_loop`);
    const seekSlider = document.getElementById(`${deckKey}_seek`);
    const pitchSlider = document.getElementById(`${deckKey}_pitch`);
    const volSlider = document.getElementById(`${deckKey}_vol`);
    const fileInput = document.getElementById(`${deckKey}_fileInput`);
    const loadBuiltinBtn = document.getElementById(`${deckKey}_loadBuiltin`);

    const eqLow = document.getElementById(`${deckKey}_eqLow`);
    const eqMid = document.getElementById(`${deckKey}_eqMid`);
    const eqHigh = document.getElementById(`${deckKey}_eqHigh`);

    playBtn.addEventListener('click', () => {
      if (!isAdminRole) return;
      const currentOffset = djConsole.getDeckCurrentTime(deckKey);
      socket.emit('dj:play', { deck: deckKey, audioOffset: currentOffset });
    });

    pauseBtn.addEventListener('click', () => {
      if (!isAdminRole) return;
      const currentOffset = djConsole.getDeckCurrentTime(deckKey);
      socket.emit('dj:pause', { deck: deckKey, currentOffset });
    });

    cueBtn.addEventListener('click', () => {
      if (!isAdminRole) return;
      socket.emit('dj:seek', { deck: deckKey, seekOffset: 0 });
    });

    loopBtn.addEventListener('click', () => {
      if (!isAdminRole) return;
      const newLoop = !djConsole.decks[deckKey].loop;
      socket.emit('dj:loop', { deck: deckKey, loop: newLoop });
    });

    seekSlider.addEventListener('input', () => {
      if (!isAdminRole) return;
      const deck = djConsole.decks[deckKey];
      const targetSec = (seekSlider.value / 100) * (deck.duration || 1);
      socket.emit('dj:seek', { deck: deckKey, seekOffset: targetSec });
    });

    pitchSlider.addEventListener('input', (e) => {
      if (!isAdminRole) return;
      socket.emit('dj:rate', { deck: deckKey, rate: parseFloat(e.target.value) });
    });

    volSlider.addEventListener('input', (e) => {
      if (!isAdminRole) return;
      socket.emit('dj:volume', { deck: deckKey, volume: parseFloat(e.target.value) });
    });

    const bindEQ = (slider, band) => {
      slider.addEventListener('input', (e) => {
        if (!isAdminRole) return;
        socket.emit('dj:eq', { deck: deckKey, band, value: parseFloat(e.target.value) });
      });
    };
    bindEQ(eqLow, 'low');
    bindEQ(eqMid, 'mid');
    bindEQ(eqHigh, 'high');

    loadBuiltinBtn.addEventListener('click', () => {
      if (!isAdminRole) return;
      const name = deckKey === 'deckA' ? 'Built-in Synth Groove A' : 'Built-in Bass Funk B';
      socket.emit('dj:loadTrack', { deck: deckKey, trackUrl: null, trackName: name });
    });

    fileInput.addEventListener('change', async (e) => {
      if (!isAdminRole || !e.target.files[0]) return;
      const file = e.target.files[0];
      const formData = new FormData();
      formData.append('audio', file);

      try {
        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: { 'x-admin-token': adminAuthToken },
          body: formData
        });
        const data = await res.json();
        if (data.success) {
          socket.emit('dj:loadTrack', {
            deck: deckKey,
            trackUrl: data.url,
            trackName: data.filename
          });
        }
      } catch (err) {
        console.error('File upload failed:', err);
      }
    });
  }

  bindDeckEvents('deckA');
  bindDeckEvents('deckB');

  masterCrossfader.addEventListener('input', (e) => {
    if (!isAdminRole) return;
    socket.emit('dj:crossfader', { value: parseFloat(e.target.value) });
  });

  // --- 6. Helper Functions ---
  function updatePlayPauseUI(deckKey, isPlaying) {
    const playBtn = document.getElementById(`${deckKey}_play`);
    const pauseBtn = document.getElementById(`${deckKey}_pause`);
    if (isPlaying) {
      playBtn.classList.add('active');
      pauseBtn.classList.remove('active');
    } else {
      playBtn.classList.remove('active');
      pauseBtn.classList.add('active');
    }
  }

  function formatTime(seconds) {
    const safeSec = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(safeSec / 60);
    const s = safeSec % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  // --- 7. Spectrum Visualizer, VU Meters, and Scrub Seek Loop ---
  function startVisualizerLoop() {
    const bufferLength = djConsole.masterAnalyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const vuDataA = new Uint8Array(32);
    const vuDataB = new Uint8Array(32);

    function render() {
      requestAnimationFrame(render);

      // Auto-scale canvas resolution
      if (visualizerCanvas.width !== visualizerCanvas.clientWidth) {
        visualizerCanvas.width = visualizerCanvas.clientWidth;
        visualizerCanvas.height = visualizerCanvas.clientHeight;
      }

      // Render Frequency Spectrum
      djConsole.masterAnalyser.getByteFrequencyData(dataArray);
      canvasCtx.fillStyle = '#090a0f';
      canvasCtx.fillRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);

      const barWidth = (visualizerCanvas.width / bufferLength) * 2.2;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * visualizerCanvas.height;
        const hue = (i / bufferLength) * 280 + 160;
        canvasCtx.fillStyle = `hsl(${hue}, 100%, 50%)`;
        canvasCtx.fillRect(x, visualizerCanvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }

      // Update VU Meters for Deck A & B
      if (djConsole.decks.deckA.analyserNode) {
        djConsole.decks.deckA.analyserNode.getByteFrequencyData(vuDataA);
        const sumA = vuDataA.reduce((acc, val) => acc + val, 0);
        const levelA = Math.min(100, (sumA / vuDataA.length / 255) * 160);
        vuA.style.height = `${levelA}%`;
      }

      if (djConsole.decks.deckB.analyserNode) {
        djConsole.decks.deckB.analyserNode.getByteFrequencyData(vuDataB);
        const sumB = vuDataB.reduce((acc, val) => acc + val, 0);
        const levelB = Math.min(100, (sumB / vuDataB.length / 255) * 160);
        vuB.style.height = `${levelB}%`;
      }

      // Update Real-Time Seek Bars and Track Time Displays
      ['deckA', 'deckB'].forEach((deckKey) => {
        const deck = djConsole.decks[deckKey];
        const curr = djConsole.getDeckCurrentTime(deckKey);
        const dur = deck.duration || 1;
        const progress = Math.min(100, (curr / dur) * 100);

        const seekSlider = document.getElementById(`${deckKey}_seek`);
        if (!seekSlider.matches(':active')) {
          seekSlider.value = progress.toFixed(1);
        }

        document.getElementById(`${deckKey}_currTime`).textContent = formatTime(curr);
        document.getElementById(`${deckKey}_durTime`).textContent = formatTime(dur);
      });
    }

    render();
  }
});