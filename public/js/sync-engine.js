/**
 * Precision NTP Clock Synchronizer & Web Audio API Scheduler
 */
class SyncEngine {
  constructor(socket) {
    this.socket = socket;
    this.audioCtx = null;
    this.clockOffset = 0; // ms to add to client Date.now() to get server Date.now()
    this.roundTripTime = 0;
    this.syncSamples = [];
    this.maxSamples = 8;
    this.isSynced = false;

    this.onOffsetUpdated = null;
  }

  initAudioContext() {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ latencyHint: 'interactive' });
    }
    if (this.audioCtx.state === 'suspended') {
      return this.audioCtx.resume();
    }
    return Promise.resolve();
  }

  startClockSync() {
    this.socket.on('ntp:pong', (data) => this.handlePong(data));
    // Initial rapid burst of 5 sync packets
    for (let i = 0; i < 5; i++) {
      setTimeout(() => this.pingServer(), i * 200);
    }
    // Continuous sync cycle every 4 seconds
    setInterval(() => this.pingServer(), 4000);
  }

  pingServer() {
    const clientTimestamp = Date.now();
    this.socket.emit('ntp:ping', { clientTimestamp });
  }

  handlePong({ clientTimestamp, serverTimestamp }) {
    const now = Date.now();
    const rtt = now - clientTimestamp;
    // NTP formula: offset = serverTime - (clientTime + RTT / 2)
    const calculatedOffset = serverTimestamp - (clientTimestamp + rtt / 2);

    this.syncSamples.push({ offset: calculatedOffset, rtt });
    if (this.syncSamples.length > this.maxSamples) {
      this.syncSamples.shift();
    }

    // Pick sample with minimum Round Trip Time (lowest network jitter)
    let bestSample = this.syncSamples[0];
    for (let i = 1; i < this.syncSamples.length; i++) {
      if (this.syncSamples[i].rtt < bestSample.rtt) {
        bestSample = this.syncSamples[i];
      }
    }

    this.clockOffset = bestSample.offset;
    this.roundTripTime = bestSample.rtt;
    this.isSynced = true;

    if (this.onOffsetUpdated) {
      this.onOffsetUpdated(this.clockOffset, this.roundTripTime);
    }
  }

  /**
   * Returns current absolute synchronized server timestamp
   */
  getServerTime() {
    return Date.now() + this.clockOffset;
  }

  /**
   * Computes precise latency-compensated AudioContext start time
   * @param {number} serverStartTime - Absolute epoch timestamp when audio must play
   * @param {number} playbackRate - Current playback pitch/speed
   * @returns {{ targetAudioContextTime: number, trackOffset: number }}
   */
  computeScheduledPlayTime(serverStartTime, trackOffset, playbackRate = 1.0) {
    if (!this.audioCtx) return { targetAudioContextTime: 0, trackOffset };

    const serverNow = this.getServerTime();
    const delayToStartMs = serverStartTime - serverNow;

    if (delayToStartMs > 0) {
      // Audio is scheduled to start in the near future
      const delayToStartSec = delayToStartMs / 1000;
      return {
        targetAudioContextTime: this.audioCtx.currentTime + delayToStartSec,
        trackOffset: trackOffset
      };
    } else {
      // Audio start time is already in the past (late arrival or mid-stream join)
      const lateSeconds = Math.abs(delayToStartMs) / 1000;
      const compensatedTrackOffset = trackOffset + (lateSeconds * playbackRate);
      return {
        targetAudioContextTime: this.audioCtx.currentTime,
        trackOffset: compensatedTrackOffset
      };
    }
  }
}

window.SyncEngine = SyncEngine;