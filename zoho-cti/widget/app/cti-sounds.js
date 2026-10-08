/* Sound cues for the CTI, made with Web Audio so there are no files to load.

     CTI.sound("dtmf", "5")   the key's real DTMF tone pair
     CTI.sound("dial")        a call is being placed
     CTI.sound("agent")       the RM's line is up
     CTI.sound("customer")    the customer picked up
     CTI.sound("hangup")      the RM ended the call
     CTI.sound("ended")       the other side ended it, or it didn't connect
     CTI.sound("mute") / ("unmute"), ("hold") / ("unhold")
     CTI.sound("error")
     CTI.ring.start() / CTI.ring.stop()   an incoming call ringing

   Browsers keep audio off until the page is touched, so the context is
   resumed on the first tap or key press. */
(function () {
  "use strict";

  let ctx = null;
  function audio() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    if (!ctx) ctx = new C();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    return ctx;
  }
  ["pointerdown", "keydown"].forEach((t) => document.addEventListener(t, audio, true));

  // One tone (or chord) at `at` seconds from now, lasting `len` seconds.
  function tone(freqs, at, len, gain, type) {
    const c = audio();
    if (!c) return;
    const t0 = c.currentTime + (at || 0);
    const g = c.createGain();
    const peak = gain || 0.07;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
    g.gain.setValueAtTime(peak, t0 + Math.max(0.02, len - 0.03));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
    g.connect(c.destination);
    for (const f of [].concat(freqs)) {
      const o = c.createOscillator();
      o.type = type || "sine";
      o.frequency.value = f;
      o.connect(g);
      o.start(t0);
      o.stop(t0 + len + 0.02);
    }
  }

  const DTMF = {
    1: [697, 1209], 2: [697, 1336], 3: [697, 1477],
    4: [770, 1209], 5: [770, 1336], 6: [770, 1477],
    7: [852, 1209], 8: [852, 1336], 9: [852, 1477],
    "*": [941, 1209], 0: [941, 1336], "#": [941, 1477],
  };

  const cues = {
    dtmf: (k) => tone(DTMF[k] || DTMF[0], 0, 0.12, 0.05),
    dial: () => { tone(660, 0, 0.07, 0.05); tone(880, 0.09, 0.09, 0.05); },
    agent: () => { tone(880, 0, 0.08); tone(1175, 0.1, 0.12); },
    customer: () => { tone(659, 0, 0.08); tone(880, 0.1, 0.08); tone(1319, 0.2, 0.16); },
    hangup: () => { tone([480, 620], 0, 0.16); tone([480, 620], 0.26, 0.16); },
    ended: () => { tone(784, 0, 0.12); tone(587, 0.16, 0.12); tone(392, 0.32, 0.22); },
    mute: () => { tone(523, 0, 0.06, 0.05); tone(392, 0.08, 0.08, 0.05); },
    unmute: () => { tone(392, 0, 0.06, 0.05); tone(523, 0.08, 0.08, 0.05); },
    hold: () => { tone(440, 0, 0.12, 0.05, "triangle"); tone(440, 0.2, 0.12, 0.05, "triangle"); },
    unhold: () => { tone(587, 0, 0.1, 0.05, "triangle"); },
    error: () => { tone(196, 0, 0.18, 0.05, "square"); tone(147, 0.2, 0.24, 0.05, "square"); },
  };

  // The ringtone is an <audio> element, not Web Audio: Zoho's widget frames
  // may play an audio element before the page has been clicked, but keep Web
  // Audio silent until then. It is a phone's ringer, not the ringback a
  // caller hears: a bright two-note trill (C6 and E6 swapping 16 times a
  // second) in two 0.8 s bursts, then quiet; 3 s a cycle, made once as a WAV
  // and looped.
  let ringEl = null;
  let ringTimer = null;
  function ringAudio() {
    if (ringEl) return ringEl;
    const rate = 16000;
    const len = rate * 3;
    const buf = new ArrayBuffer(44 + len * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); str(8, "WAVE"); str(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, "data"); v.setUint32(40, len * 2, true);
    let phase = 0;
    for (let i = 0; i < len; i++) {
      const t = i / rate;
      const f = Math.floor(t * 32) % 2 ? 1318.5 : 1046.5;
      phase += (2 * Math.PI * f) / rate;
      const burst = t < 1 ? t : t - 1;
      const on = t < 1.8 && burst < 0.8;
      const edge = on ? Math.min(1, burst / 0.01, (0.8 - burst) / 0.01) : 0;
      const s = (Math.sin(phase) * 0.8 + Math.sin(2 * phase) * 0.15) * edge;
      v.setInt16(44 + i * 2, s * 9000, true);
    }
    ringEl = new Audio(URL.createObjectURL(new Blob([buf], { type: "audio/wav" })));
    ringEl.loop = true;
    ringEl.dataset.cti = "1";
    return ringEl;
  }

  const ring = {
    start() {
      ring.stop();
      const el = ringAudio();
      el.currentTime = 0;
      el.play().catch(() => {
        // Not allowed here: Web Audio, which plays once the page is clicked.
        const once = () => {
          for (const start of [0, 1]) {
            for (let k = 0; k < 25; k++) tone(k % 2 ? 1318.5 : 1046.5, start + k / 32, 1 / 32, 0.05);
          }
        };
        once();
        ringTimer = setInterval(once, 3000);
      });
    },
    stop() {
      if (ringEl) ringEl.pause();
      clearInterval(ringTimer);
      ringTimer = null;
    },
  };

  window.CTI = Object.assign(window.CTI || {}, {
    sound(name, arg) {
      try { if (cues[name]) cues[name](arg); } catch (e) {}
    },
    ring,
    // False until this page has been clicked once: before that the browser
    // keeps it silent, ringing included.
    soundOn() {
      const ua = navigator.userActivation;
      return ua ? ua.hasBeenActive : !!(ctx && ctx.state === "running");
    },
  });
})();
