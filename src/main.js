// Page entry. One page, two modes sharing the same engine:
//   preview (default): the film alone on a black page, with one glass play button in the middle of it. t comes from
//                      the <audio> clock, or from the last frame drawn while paused. t is SONG time: the film starts
//                      at -safety.preroll with a silent warning page, so ?t=-5 is that page and ?t=0 the first frame
//                      of the song.
//   export (?mode=export&w=..&h=..): no UI; Node drives window.__mv frame by frame
import { createEngine, loadSteps } from './engine/engine.js';
import { assetUrl as urlOf } from './engine/url.js';

const qs = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const getJson = async (p) => {
  const r = await fetch(urlOf(p));
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.json();
};
const isExport = qs.get('mode') === 'export';

// ---- loading (preview only): a bar over the picture, one step per file, font and silhouette ------------------------
const boot = (() => {
  if (isExport) return { expect() {}, step() {}, fail() {}, done() {} };
  let total = 1, n = 0;
  return {
    expect(k) { total += k; },
    /** One more thing is loaded. Resolves once the page had the chance to repaint, so the bar is seen to move. */
    step(label) {
      n++;
      $('loadFill').style.width = `${(100 * n / total).toFixed(1)}%`;
      $('loadText').textContent = `${String(n).padStart(2, ' ')} / ${total}   ${label}`;
      if (document.visibilityState !== 'visible') return undefined;         // nobody is looking: nothing to wait for
      return new Promise((res) => { const id = setTimeout(res, 80); requestAnimationFrame(() => { clearTimeout(id); res(); }); });
    },
    fail(e) { $('loading').classList.add('failed'); $('loadText').textContent = `could not start: ${e.message}`; },
    done() { $('loading').hidden = true; },
  };
})();

let cfg, engine, width, height;
try {
  cfg = await getJson('config.json');
  boot.expect(2 + loadSteps(cfg));
  boot.step('config.json');
  const [featuresData, lyricsData] = await Promise.all([
    getJson(cfg.paths.features).then((d) => (boot.step('audio features'), d)),
    getJson(cfg.paths.lyrics).then((d) => (boot.step('lyric lines'), d)),
  ]);
  if (isExport) {
    width = +qs.get('w') || cfg.video.previewWidth;
    height = +qs.get('h') || cfg.video.previewHeight;
  } else {
    // the preview is the whole window now, so it renders at the size it is shown at (capped: 1080p is plenty, and
    // the film is drawn in virtual 1920x1080 units, so any resolution gives the same picture)
    const s = Math.min(innerWidth / 16, innerHeight / 9);          // css px per virtual unit
    const h = Math.max(360, Math.min(1080, Math.round(s * 9 * Math.min(devicePixelRatio || 1, 2))));
    width = +qs.get('w') || Math.round(h * 16 / 9);
    height = +qs.get('h') || h;
  }
  // ?lab=<set> renders the check cards of src/scenes/lab.js instead of the film (node export/export.mjs --lab <set> --sheet ...)
  engine = await createEngine({ canvas: $('view'), width, height, cfg, featuresData, lyricsData, flipY: isExport, lab: qs.get('lab'), onStep: isExport ? null : boot.step });
} catch (e) { boot.fail(e); throw e; }

if (isExport) setupExport(); else setupPreview();

// ---------------------------------------------------------------------------------
function setupExport() {
  document.body.classList.add('export');
  const buf = new Uint8Array(width * height * 4);
  // One WebSocket carries all frames; the Node side acks each frame once ffmpeg has consumed it.
  const ws = new WebSocket(`ws://${location.host}/__frames`);
  const opened = new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('frame socket failed')); });
  const send = (data) => new Promise((res, rej) => {
    ws.onmessage = res;
    ws.onclose = () => rej(new Error('frame socket closed'));
    ws.send(data);
  });
  window.__mv = {
    ready: true,
    duration: engine.duration,
    renderer: engine.rendererInfo(),
    /** Render stills at arbitrary times (QA contact sheets). */
    async exportTimes(times) {
      await opened;
      for (const t of times) { engine.renderFrame(t); engine.readPixels(buf); await send(buf); }
      return times.length;
    },
    /** Render frames [from, to) at `fps` and send each one (raw RGBA) to the Node side, in order. */
    async exportRange(from, to, fps) {
      await opened;
      const ms = { render: 0, read: 0, send: 0 };       // profiling only; never affects the frames
      for (let i = from; i < to; i++) {
        const a = performance.now();
        engine.renderFrame(i / fps);
        const b = performance.now();
        engine.readPixels(buf);
        const c = performance.now();
        await send(buf);
        ms.render += b - a; ms.read += c - b; ms.send += performance.now() - c;
      }
      for (const k in ms) ms[k] = +(ms[k] / (to - from)).toFixed(1);
      return ms;
    },
  };
}

// ---------------------------------------------------------------------------------
function setupPreview() {
  const audio = $('audio'), playBtn = $('play'), toast = $('toast');
  const PRE = engine.preroll, D = engine.duration;      // the film runs from song time -PRE (silent warning page) to D
  audio.src = urlOf(cfg.paths.audio);

  const lim = (v) => Math.max(-PRE, Math.min(D, v));
  let t = lim(qs.has('t') ? +qs.get('t') || 0 : -PRE);   // current time while paused
  let lastDrawn = NaN;
  // Two clocks (preview transport only: a frame still depends on t alone). While the song sounds, the <audio> element
  // is the clock. Before the song there is no audio clock, and there is none either when the sound cannot be had (no
  // file, the browser will not start it, nothing to play it on): then the preview runs on the wall clock, silently.
  //   wall = { t0, at }       running on the wall clock: song time t0 at performance.now() === at
  //   mute = { why, retry }   the sound is not used, and why; retry = try it again at the next press of play
  //   heard = { t, at }       the last time the audio clock was seen to move
  let wall = null, mute = null, heard = { t: -1, at: 0 };
  audio.currentTime = Math.max(0, t);

  const playing = () => wall !== null || (!audio.paused && !audio.ended);
  const now = () => (wall ? Math.min(mute ? D : 0, wall.t0 + (performance.now() - wall.at) / 1000) : !audio.paused && !audio.ended ? audio.currentTime : t);
  // ---- the interface is the button and nothing else ---------------------------------
  let toastTimer = 0, idleTimer = 0;
  /** A failure the picture cannot show (usually: the sound will not start). Fades by itself. */
  const say = (msg) => {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 5600);
  };
  /** While the film runs, the pointer steps out of the way after a moment of stillness (the button is gone by then). */
  const wake = () => {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (playing()) document.body.classList.add('idle'); }, 1600);
  };
  addEventListener('pointermove', wake, { passive: true });
  addEventListener('pointerdown', wake, { passive: true });
  // `body.playing` is what hides the glass button: it is a play button, never a pause button, so it exists only while
  // the film stands still. The picture itself is the pause: a click on it stops the film.
  const label = () => {
    const p = playing();
    playBtn.dataset.state = p ? 'playing' : 'paused';
    playBtn.setAttribute('aria-label', p ? 'pause' : 'play');
    document.body.classList.toggle('playing', p);
    if (p) wake(); else { document.body.classList.remove('idle'); clearTimeout(idleTimer); }
  };
  /** Start the sound at t (>= 0). If it will not start, the picture goes on without it rather than stand still. */
  const start = () => {
    heard = { t: -1, at: performance.now() };
    if (Math.abs(audio.currentTime - t) > 0.02) audio.currentTime = t;      // (the wall clock has run on without it)
    audio.play().catch((e) => {
      if (e.name === 'AbortError' || !audio.paused) return;                 // overtaken by a pause or a seek of ours
      mute = { why: e.name === 'NotAllowedError' ? 'the browser did not let the sound start: press the button again' : `no sound (${e.name})`, retry: true };
      say(mute.why);
      wall = { t0: t, at: performance.now() }; label();
    });
  };
  /** Always reached from a click or a key: whatever only the user may start has to be started in here. */
  const play = () => {
    if (mute?.retry) mute = null;
    if (t >= D - 0.05) { t = 0; audio.currentTime = 0; }                    // at the end: once more, from the song
    if (mute) wall = { t0: t, at: performance.now() };
    else if (t < 0) {
      wall = { t0: t, at: performance.now() };
      // The song starts by itself when the page before it is over, and that is no longer inside this click. A browser
      // that lets only the user start sound must have seen this element started by the user once: started here and
      // stopped at once (no sound), it may be started later.
      audio.play().catch(() => {}); audio.pause();
    } else start();
    label();
  };
  const pause = () => { t = now(); wall = null; if (!audio.paused) audio.pause(); label(); };
  const setT = (v) => { const was = playing(); pause(); t = lim(v); audio.currentTime = Math.max(0, t); if (was) play(); };

  playBtn.onclick = () => (playing() ? pause() : play());
  // while the film runs the button is not in the way (body.playing): the click that stops it lands on the picture
  $('view').onclick = () => (playing() ? pause() : play());
  audio.onplay = audio.onpause = () => { if (!wall && audio.paused && !audio.ended) t = audio.currentTime; label(); };
  audio.onended = () => { t = D; label(); };
  audio.onerror = () => {                                 // no file, or one the browser cannot play: the picture alone
    const was = playing();
    pause();
    mute = { why: `no sound: "${cfg.paths.audio}" is missing or cannot be played here`, retry: false };
    say(mute.why);
    if (was) play();
  };
  window.addEventListener('keydown', (e) => {
    const dir = e.code === 'ArrowLeft' ? -1 : e.code === 'ArrowRight' ? 1 : 0;
    if (e.code === 'Space') { e.preventDefault(); playBtn.blur(); playBtn.click(); }    // (a focused button would click a second time)
    else if (dir) { e.preventDefault(); setT(now() + dir * (e.shiftKey ? 5 : 1)); }
    else if (e.key === ',') { pause(); setT(t - 1 / 60); }
    else if (e.key === '.') { pause(); setT(t + 1 / 60); }
  });

  // A frame is a function of t alone: one call, and the picture is that moment of the film.
  const draw = (now) => engine.renderFrame(now);

  // requestAnimationFrame is only a repaint trigger; the frame content depends on t alone.
  function tick() {
    let n = now();
    if (wall && !mute && n >= 0) {                        // the page is over: the song starts
      wall = null; t = 0; n = 0;
      if (audio.currentTime !== 0) audio.currentTime = 0;
      start(); label();
    } else if (wall && n >= D) { wall = null; t = D; label(); }
    if (!wall && !audio.paused && !audio.ended) {         // the audio clock has to be seen to move
      const c = audio.currentTime, w = performance.now(), waiting = audio.seeking || audio.readyState < 3;
      if (c !== heard.t) heard = { t: c, at: w };
      else if (w - heard.at > (waiting ? 4000 : 2500)) {  // it stands still: go on without it rather than freeze
        t = c; audio.pause();
        mute = { why: `the sound ${waiting ? 'does not load' : 'does not advance (no output device?)'}: playing without it; press the button twice to try again`, retry: true };
        say(mute.why);
        wall = { t0: t, at: w }; label();
      }
    }
    if (n !== lastDrawn) { draw(n); lastDrawn = n; }
    requestAnimationFrame(tick);
  }
  tick();
  boot.done();
  window.__preview = { engine, setT };   // handy for debugging from the console
}
