/**
 * Wedding Background Music Player
 * Track  : Jashn E Bahaaraa (Instrumental Flute)
 * Segment: 00:24 → 01:26 (looped seamlessly)
 *
 * Strategy
 * ─────────
 * 1. Preload audio silently (volume = 0) so there is no buffering gap.
 * 2. On first user interaction (click / touch / keydown), seek to START_TIME
 *    and begin a gentle volume ramp-up (fade-in over FADE_IN_MS ms).
 *    → Music enters as ambient atmosphere, never feels "skipped into".
 * 3. A lightweight requestAnimationFrame loop watches the current time.
 *    When it crosses END_TIME − CROSSFADE_MS, we simultaneously:
 *      a. Fade OUT the primary element.
 *      b. Seek a secondary <audio> clone to START_TIME and fade it IN.
 *    The two elements cross-fade so the loop joint is inaudible.
 * 4. On loop-complete, the secondary becomes primary and the cycle repeats.
 * 5. The existing mute/unmute button is wired in without DOM changes.
 *
 * Drop-in usage
 * ─────────────
 * Replace your current audio script block with:
 *
 *   <script src="wedding-music-player.js"></script>
 *   <script>
 *     WeddingPlayer.init({
 *       src: 'Jashn_E_Bahaaraa_Instrumental_Flute_Jodhaa_Akbar_320_Kbps.mp3',
 *       muteButtonSelector: '#muteBtn',   // ← your existing button selector
 *       muteIconSelector:   '#muteIcon',  // ← your existing icon selector (optional)
 *       mutedClass:         'muted',      // ← class toggled on mute (optional)
 *     });
 *   </script>
 */

(function (global) {
  'use strict';

  /* ─── Tuneable constants ──────────────────────────────────────────────── */
  var START_TIME    = 24;          // seconds — segment start
  var END_TIME      = 86;          // seconds — segment end  (01:26)
  var FADE_IN_MS    = 2800;        // ms — initial fade-in on first interaction
  var CROSSFADE_MS  = 1800;        // ms — cross-fade window before loop point
  var TARGET_VOLUME = 0.32;        // master volume (soft, ambient)
  var TICK_MS       = 80;          // rAF poll interval guard (ms)

  /* ─── Internal state ─────────────────────────────────────────────────── */
  var cfg          = {};
  var primary      = null;   // active <audio> element
  var secondary    = null;   // preloaded clone for cross-fade
  var muted        = true;
  var started      = false;  // first-interaction gate
  var crossfading  = false;
  var rafId        = null;
  var lastTick     = 0;
  var startPromise = null;

  /* ─── Helpers ────────────────────────────────────────────────────────── */
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function waitForAudioReady(el) {
    return new Promise(function (resolve) {
      if (!el) {
        resolve();
        return;
      }

      if (el.readyState >= 1) {
        resolve();
        return;
      }

      function done() {
        el.removeEventListener('loadedmetadata', done);
        el.removeEventListener('canplay', done);
        resolve();
      }

      el.addEventListener('loadedmetadata', done, { once: true });
      el.addEventListener('canplay', done, { once: true });
      el.load();
    });
  }

  function seekToStart(el) {
    return new Promise(function (resolve) {
      if (!el) {
        resolve();
        return;
      }

      function finish() {
        el.removeEventListener('seeked', finish);
        resolve();
      }

      try {
        if (Math.abs(el.currentTime - START_TIME) < 0.05) {
          resolve();
          return;
        }

        el.addEventListener('seeked', finish, { once: true });
        el.currentTime = START_TIME;
        setTimeout(finish, 250);
      } catch (err) {
        resolve();
      }
    });
  }

  /**
   * Smoothly ramp an <audio> element's volume from `from` to `to`
   * over `durationMs` milliseconds using exponential easing.
   * Returns a Promise that resolves when done.
   */
  function rampVolume(el, from, to, durationMs) {
    return new Promise(function (resolve) {
      var start  = performance.now();
      el.volume  = clamp(from, 0, 1);

      function step(now) {
        var elapsed  = now - start;
        var progress = clamp(elapsed / durationMs, 0, 1);
        // ease-out cubic
        var eased    = 1 - Math.pow(1 - progress, 3);
        el.volume    = clamp(from + (to - from) * eased, 0, 1);
        if (progress < 1) {
          requestAnimationFrame(step);
        } else {
          el.volume = clamp(to, 0, 1);
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  /** Create a fresh, silent <audio> element preloaded to START_TIME. */
  function buildAudioEl(src) {
    var el       = document.createElement('audio');
    el.src       = src;
    el.preload   = 'auto';
    el.volume    = 0;
    el.currentTime = START_TIME;
    // Prevent browser from showing native controls
    el.controls  = false;
    // Keep iOS from routing through speaker lock screen
    el.setAttribute('playsinline', '');
    el.setAttribute('webkit-playsinline', '');
    return el;
  }

  /** Effective target volume (0 when muted). */
  function effectiveVolume() {
    return muted ? 0 : TARGET_VOLUME;
  }

  /* ─── Cross-fade loop engine ─────────────────────────────────────────── */
  function triggerCrossfade() {
    if (crossfading) return;
    crossfading = true;

    // Prepare secondary
    secondary           = buildAudioEl(cfg.src);
    secondary.volume    = 0;
    secondary.currentTime = START_TIME;

    var playPromise = secondary.play();
    if (playPromise !== undefined) {
      playPromise.catch(function () { /* autoplay guard — ignore */ });
    }

    var fadeTo = effectiveVolume();

    // Simultaneously fade out primary, fade in secondary
    rampVolume(primary,   primary.volume, 0,      CROSSFADE_MS);
    rampVolume(secondary, 0,              fadeTo,  CROSSFADE_MS).then(function () {
      // Primary is silent — pause and discard
      primary.pause();
      primary.src = '';   // release media resource
      primary     = secondary;
      secondary   = null;
      crossfading = false;
    });
  }

  function rafLoop(now) {
    if (!primary || !started) {
      rafId = requestAnimationFrame(rafLoop);
      return;
    }

    // Throttle to TICK_MS to save CPU
    if (now - lastTick < TICK_MS) {
      rafId = requestAnimationFrame(rafLoop);
      return;
    }
    lastTick = now;

    var ct          = primary.currentTime;
    var triggerAt   = END_TIME - (CROSSFADE_MS / 1000);

    if (!crossfading && ct >= triggerAt) {
      triggerCrossfade();
    }

    rafId = requestAnimationFrame(rafLoop);
  }

  /* ─── First-interaction handler ──────────────────────────────────────── */
  function removeFirstInteractionListeners() {
    ['click', 'touchstart', 'keydown', 'scroll'].forEach(function (evt) {
      document.removeEventListener(evt, onFirstInteraction);
    });
  }

  function beginPlaybackFlow() {
    if (started) return Promise.resolve();
    if (startPromise) return startPromise;

    started = true;
    removeFirstInteractionListeners();

    startPromise = waitForAudioReady(primary)
      .then(function () {
        primary.volume = 0;
        return seekToStart(primary);
      })
      .then(function () {
        var playPromise = primary.play();
        if (playPromise !== undefined) return playPromise;
      })
      .then(function () {
        rampVolume(primary, 0, effectiveVolume(), FADE_IN_MS);
        if (!rafId) rafId = requestAnimationFrame(rafLoop);
        startPromise = null;
      })
      .catch(function (err) {
        started = false;
        startPromise = null;
        console.warn('[WeddingPlayer] Autoplay blocked:', err.message);
        ['click', 'touchstart', 'keydown', 'scroll'].forEach(function (evt) {
          document.addEventListener(evt, onFirstInteraction, { passive: true, once: true });
        });
      });

    return startPromise;
  }

  function ensureStarted() {
    if (started) return Promise.resolve();
    if (startPromise) return startPromise;

    started = true;
    removeFirstInteractionListeners();
    primary.currentTime = START_TIME;
    primary.volume      = 0;

    var playPromise = primary.play();
    var afterPlay   = function () {
      rampVolume(primary, 0, effectiveVolume(), FADE_IN_MS);
      if (!rafId) rafId = requestAnimationFrame(rafLoop);
      startPromise = null;
    };

    if (playPromise !== undefined) {
      startPromise = playPromise.then(function () {
        afterPlay();
      }).catch(function (err) {
        // Autoplay still blocked somehow — retry on next interaction
        started = false;
        startPromise = null;
        console.warn('[WeddingPlayer] Autoplay blocked:', err.message);
        ['click', 'touchstart', 'keydown', 'scroll'].forEach(function (evt) {
          document.addEventListener(evt, onFirstInteraction, { passive: true, once: true });
        });
      });
      return startPromise;
    }

    afterPlay();
    return Promise.resolve();
  }

  function onFirstInteraction(evt) {
    var btn = cfg.muteButtonSelector && document.querySelector(cfg.muteButtonSelector);
    if (btn && evt && evt.target && btn.contains(evt.target)) return;
    beginPlaybackFlow();
  }

  /* ─── Mute / Unmute ─────────────────────────────────────────────────── */
  function applyMuteState() {
    var el = primary;

    // Update button visual
    var btn = cfg.muteButtonSelector  && document.querySelector(cfg.muteButtonSelector);
    var ico = cfg.muteIconSelector    && document.querySelector(cfg.muteIconSelector);
    var cls = cfg.mutedClass          || 'muted';

    if (btn) {
      muted ? btn.classList.add(cls) : btn.classList.remove(cls);
      btn.setAttribute('aria-label', muted ? 'Unmute music' : 'Mute music');
    }
    if (ico) {
      // Common pattern: swap a data-attribute or class on an icon element
      ico.dataset.muted = muted ? 'true' : 'false';
    }

    if (!el || !started) return;

    if (muted) {
      rampVolume(el, el.volume, 0, 400);
      if (secondary) rampVolume(secondary, secondary.volume, 0, 400);
    } else {
      var target = TARGET_VOLUME;
      rampVolume(el, el.volume, target, 400);
      // secondary, if active mid-crossfade, will reach its own target naturally
    }
  }

  function toggleMute(evt) {
    if (evt) {
      evt.preventDefault();
      evt.stopPropagation();
    }

    if (!started) {
      muted = false;
      applyMuteState();
      beginPlaybackFlow();
      return;
    }

    muted = !muted;
    applyMuteState();
  }

  /* ─── Public API ─────────────────────────────────────────────────────── */
  var WeddingPlayer = {
    /**
     * Initialise the player.
     * @param {object} options
     * @param {string}  options.src                 — path to the MP3
     * @param {string} [options.muteButtonSelector] — CSS selector for the mute button
     * @param {string} [options.muteIconSelector]   — CSS selector for an icon inside the button
     * @param {string} [options.mutedClass]         — class to toggle on mute (default: "muted")
     * @param {number} [options.volume]             — override TARGET_VOLUME (0–1)
     * @param {number} [options.startTime]          — override START_TIME in seconds
     * @param {number} [options.endTime]            — override END_TIME in seconds
     */
    init: function (options) {
      cfg = options || {};

      // Allow config overrides
      if (typeof cfg.volume    === 'number') TARGET_VOLUME = clamp(cfg.volume, 0, 1);
      if (typeof cfg.startTime === 'number') START_TIME    = cfg.startTime;
      if (typeof cfg.endTime   === 'number') END_TIME      = cfg.endTime;

      // Build primary audio element, preload silently
      primary = buildAudioEl(cfg.src);
      document.body.appendChild(primary);   // required for iOS to preload

      // Wire mute button
      var btn = cfg.muteButtonSelector && document.querySelector(cfg.muteButtonSelector);
      if (btn) {
        btn.addEventListener('click', toggleMute);
      }

      // Listen for first interaction
      ['click', 'touchstart', 'keydown', 'scroll'].forEach(function (evt) {
        document.addEventListener(evt, onFirstInteraction, { passive: true, once: true });
      });

      // Attempt silent autoplay preload — browsers allow setting currentTime
      // and preloading even when play() is blocked.
      primary.load();
      applyMuteState();
    },

    /** Programmatically mute. */
    mute:   function () { if (!muted) toggleMute(); },
    /** Programmatically unmute. */
    unmute: function () { if (muted)  toggleMute(); },
    /** Query mute state. */
    isMuted: function () { return muted; },
    /** Stop playback and clean up. */
    destroy: function () {
      if (rafId) cancelAnimationFrame(rafId);
      if (primary)   { primary.pause();   primary.src   = ''; }
      if (secondary) { secondary.pause(); secondary.src = ''; }
      started = crossfading = false;
    }
  };

  global.WeddingPlayer = WeddingPlayer;

}(window));
