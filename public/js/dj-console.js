/**
 * Web Audio API Dual-Deck Audio Engine & DSP Graph
 */
class DJConsole {
  constructor(syncEngine) {
    this.sync = syncEngine;
    this.audioCtx = null;

    // Master nodes
    this.masterGain = null;
    this.masterAnalyser = null;

    // Decks graph structures
    this.decks = {
      deckA: {
        buffer: null,
        sourceNode: null,
        eqLowNode: null,
        eqMidNode: null,
        eqHighNode: null,
        gainNode: null,
        crossfaderGainNode: null,
        analyserNode: null,
        isPlaying: false,
        duration: 0,
        playbackRate: 1.0,
        audioOffset: 0,
        loop: true,
        startedContextTime: 0
      },
      deckB: {
        buffer: null,
        sourceNode: null,
        eqLowNode: null,
        eqMidNode: null,
        eqHighNode: null,
        gainNode: null,
        crossfaderGainNode: null,
        analyserNode: null,
        isPlaying: false,
        duration: 0,
        playbackRate: 1.0,
        audioOffset: 0,
        loop: true,
        startedContextTime: 0
      }
    };
  }

  setupAudioGraph() {
    this.audioCtx = this.sync.audioCtx;

    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = 1.0;

    this.masterAnalyser = this.audioCtx.createAnalyser();
    this.masterAnalyser.fftSize = 512;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.audioCtx.destination);

    // Initialize Deck A and Deck B DSP graphs
    this.setupDeckGraph('deckA');
    this.setupDeckGraph('deckB');

    // Create synthetic demo tracks so it plays immediately with zero uploads required
    this.decks.deckA.buffer = this.generateSynthTrackA();
    this.decks.deckA.duration = this.decks.deckA.buffer.duration;

    this.decks.deckB.buffer = this.generateSynthTrackB();
    this.decks.deckB.duration = this.decks.deckB.buffer.duration;
  }

  setupDeckGraph(deckKey) {
    const deck = this.decks[deckKey];

    // 3-Band Parametric EQ: Low (Shelf), Mid (Peaking), High (Shelf)
    deck.eqLowNode = this.audioCtx.createBiquadFilter();
    deck.eqLowNode.type = 'lowshelf';
    deck.eqLowNode.frequency.value = 250; // 250 Hz

    deck.eqMidNode = this.audioCtx.createBiquadFilter();
    deck.eqMidNode.type = 'peaking';
    deck.eqMidNode.frequency.value = 1500; // 1.5 kHz
    deck.eqMidNode.Q.value = 1.0;

    deck.eqHighNode = this.audioCtx.createBiquadFilter();
    deck.eqHighNode.type = 'highshelf';
    deck.eqHighNode.frequency.value = 6500; // 6.5 kHz

    // Individual Deck Volume
    deck.gainNode = this.audioCtx.createGain();
    deck.gainNode.gain.value = 0.85;

    // Crossfader Gain Splitter
    deck.crossfaderGainNode = this.audioCtx.createGain();
    deck.crossfaderGainNode.gain.value = 0.707; // Default 50/50 equal-power

    // Deck level meter analyser
    deck.analyserNode = this.audioCtx.createAnalyser();
    deck.analyserNode.fftSize = 64;

    // Chain: EQ-Low -> EQ-Mid -> EQ-High -> DeckGain -> CrossfaderGain -> Analyser -> MasterGain
    deck.eqLowNode.connect(deck.eqMidNode);
    deck.eqMidNode.connect(deck.eqHighNode);
    deck.eqHighNode.connect(deck.gainNode);
    deck.gainNode.connect(deck.crossfaderGainNode);
    deck.crossfaderGainNode.connect(deck.analyserNode);
    deck.analyserNode.connect(this.masterGain);
  }

  /**
   * Synchronized Playback Start
   */
  play(deckKey, serverStartTime, audioOffset, playbackRate = 1.0) {
    const deck = this.decks[deckKey];
    if (!deck || !deck.buffer) return;

    this.stopDeckSource(deckKey);

    const { targetAudioContextTime, trackOffset } = this.sync.computeScheduledPlayTime(
      serverStartTime,
      audioOffset,
      playbackRate
    );

    const source = this.audioCtx.createBufferSource();
    source.buffer = deck.buffer;
    source.playbackRate.value = playbackRate;
    source.loop = deck.loop;

    source.connect(deck.eqLowNode);

    const safeOffset = (deck.duration > 0) ? (trackOffset % deck.duration) : 0;
    source.start(targetAudioContextTime, safeOffset);

    deck.sourceNode = source;
    deck.isPlaying = true;
    deck.playbackRate = playbackRate;
    deck.audioOffset = safeOffset;
    deck.startedContextTime = targetAudioContextTime;
  }

  pause(deckKey, currentOffset) {
    const deck = this.decks[deckKey];
    if (!deck) return;

    this.stopDeckSource(deckKey);
    deck.isPlaying = false;
    deck.audioOffset = currentOffset;
  }

  stopDeckSource(deckKey) {
    const deck = this.decks[deckKey];
    if (deck.sourceNode) {
      try {
        deck.sourceNode.stop();
        deck.sourceNode.disconnect();
      } catch (e) {
        // Source already terminated
      }
      deck.sourceNode = null;
    }
  }

  setEQ(deckKey, band, valueDb) {
    const deck = this.decks[deckKey];
    if (!deck) return;
    const now = this.audioCtx.currentTime;
    if (band === 'low' && deck.eqLowNode) {
      deck.eqLowNode.gain.setValueAtTime(valueDb, now);
    } else if (band === 'mid' && deck.eqMidNode) {
      deck.eqMidNode.gain.setValueAtTime(valueDb, now);
    } else if (band === 'high' && deck.eqHighNode) {
      deck.eqHighNode.gain.setValueAtTime(valueDb, now);
    }
  }

  setVolume(deckKey, vol) {
    const deck = this.decks[deckKey];
    if (deck && deck.gainNode) {
      deck.gainNode.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    }
  }

  setPlaybackRate(deckKey, rate) {
    const deck = this.decks[deckKey];
    if (deck) {
      deck.playbackRate = rate;
      if (deck.sourceNode) {
        deck.sourceNode.playbackRate.setValueAtTime(rate, this.audioCtx.currentTime);
      }
    }
  }

  setLoop(deckKey, loop) {
    const deck = this.decks[deckKey];
    if (deck) {
      deck.loop = loop;
      if (deck.sourceNode) {
        deck.sourceNode.loop = loop;
      }
    }
  }

  /**
   * Constant-Power Crossfader Curve
   * x = 0 (Full Deck A) -> x = 0.5 (Equal split) -> x = 1 (Full Deck B)
   */
  setCrossfader(x) {
    if (!this.audioCtx) return;
    const gainA = Math.cos(x * 0.5 * Math.PI);
    const gainB = Math.sin(x * 0.5 * Math.PI);
    const now = this.audioCtx.currentTime;

    this.decks.deckA.crossfaderGainNode.gain.setValueAtTime(gainA, now);
    this.decks.deckB.crossfaderGainNode.gain.setValueAtTime(gainB, now);
  }

  async loadAudioFile(deckKey, url) {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);
    this.decks[deckKey].buffer = audioBuffer;
    this.decks[deckKey].duration = audioBuffer.duration;
    this.decks[deckKey].audioOffset = 0;
  }

  getDeckCurrentTime(deckKey) {
    const deck = this.decks[deckKey];
    if (!deck.isPlaying || !this.audioCtx) {
      return deck.audioOffset;
    }
    const elapsed = (this.audioCtx.currentTime - deck.startedContextTime) * deck.playbackRate;
    let curr = deck.audioOffset + elapsed;
    if (deck.duration > 0 && deck.loop) {
      curr = curr % deck.duration;
    }
    return Math.max(0, curr);
  }

  /**
   * Generates a 4-bar 128 BPM Synthetic House Beat (Deck A preset)
   */
  generateSynthTrackA() {
    const sampleRate = this.audioCtx.sampleRate;
    const bpm = 128;
    const barSec = (60 / bpm) * 4;
    const totalSec = barSec * 4; // 4 bars = 7.5s
    const length = Math.floor(sampleRate * totalSec);
    const buffer = this.audioCtx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const beatInterval = Math.floor(sampleRate * (60 / bpm));

    for (let i = 0; i < length; i++) {
      // 4-on-the-floor Kick Drum (sine drop)
      const beatPhase = i % beatInterval;
      const t = beatPhase / sampleRate;
      let kick = 0;
      if (t < 0.22) {
        const freq = 130 * Math.exp(-t * 22);
        kick = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 14);
      }

      // Offbeat Hi-hat
      const offbeatPhase = (i + Math.floor(beatInterval / 2)) % beatInterval;
      const tHat = offbeatPhase / sampleRate;
      let hat = 0;
      if (tHat < 0.08) {
        hat = (Math.random() * 2 - 1) * Math.exp(-tHat * 60) * 0.35;
      }

      // Minor synth stab
      const step16 = Math.floor(i / (beatInterval / 4)) % 16;
      let synth = 0;
      if (step16 === 4 || step16 === 10 || step16 === 14) {
        const tSynth = (i % (beatInterval / 4)) / sampleRate;
        synth = (Math.sin(2 * Math.PI * 220 * tSynth) + 0.5 * Math.sin(2 * Math.PI * 261.6 * tSynth)) * Math.exp(-tSynth * 12) * 0.4;
      }

      const mixed = (kick * 0.75 + hat * 0.4 + synth * 0.5);
      left[i] = mixed;
      right[i] = mixed;
    }
    return buffer;
  }

  /**
   * Generates a 4-bar 120 BPM Synthetic Funk Bass Groove (Deck B preset)
   */
  generateSynthTrackB() {
    const sampleRate = this.audioCtx.sampleRate;
    const bpm = 120;
    const barSec = (60 / bpm) * 4;
    const totalSec = barSec * 4; // 8.0s
    const length = Math.floor(sampleRate * totalSec);
    const buffer = this.audioCtx.createBuffer(2, length, sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);

    const sixteenth = Math.floor(sampleRate * (60 / bpm) / 4);
    const notes = [55, 55, 65.4, 73.4, 55, 82.4, 73.4, 55]; // Bass line frequencies

    for (let i = 0; i < length; i++) {
      const step = Math.floor(i / sixteenth) % 16;
      const noteFreq = notes[step % notes.length];
      const tNote = (i % sixteenth) / sampleRate;

      // Punchy Bass Synth (Sawtooth approximation + Filter env)
      let bass = 0;
      if (tNote < 0.2) {
        bass = (Math.sin(2 * Math.PI * noteFreq * tNote) +
                0.5 * Math.sin(2 * Math.PI * (noteFreq * 2) * tNote) +
                0.2 * Math.sin(2 * Math.PI * (noteFreq * 3) * tNote)) * Math.exp(-tNote * 8) * 0.55;
      }

      // Snare on 2 and 4 (step 4 and 12)
      let snare = 0;
      if (step === 4 || step === 12) {
        const tSnare = (i % (sixteenth * 4)) / sampleRate;
        if (tSnare < 0.18) {
          const noise = (Math.random() * 2 - 1) * Math.exp(-tSnare * 25);
          const body = Math.sin(2 * Math.PI * 180 * tSnare) * Math.exp(-tSnare * 30);
          snare = (noise * 0.6 + body * 0.4) * 0.6;
        }
      }

      const mixed = bass + snare;
      left[i] = mixed;
      right[i] = mixed;
    }
    return buffer;
  }
}

window.DJConsole = DJConsole;