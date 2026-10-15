'use strict';
/* ---------- Config & helpers ---------- */
const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@master/weights'; // or './models' if you host the weights yourself
const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const $ = s => document.querySelector(s);
const W = 800, H = 500, cv = $('#cv'), ctx = cv.getContext('2d'), vid = $('#vid');
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rnd = (a, b) => a + Math.random() * (b - a);
const store = {
  get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};
const LV = { easy: { s: .8, l: 5 }, normal: { s: 1, l: 3 }, hard: { s: 1.3, l: 2 } };

/* ---------- Sound ---------- */
let AC, sound = store.get('fa_sound', true);
function beep(f = 600, d = .1, t = 'sine') {
  if (!sound) return;
  try {
    AC = AC || new AudioContext();
    const o = AC.createOscillator(), g = AC.createGain();
    o.type = t; o.frequency.value = f; g.gain.value = .06;
    g.gain.exponentialRampToValueAtTime(.001, AC.currentTime + d);
    o.connect(g); g.connect(AC.destination); o.start(); o.stop(AC.currentTime + d);
  } catch {}
}
const updSnd = () => $('#sndBtn').textContent = sound ? '🔊 Sound on' : '🔇 Sound off';
$('#sndBtn').onclick = () => { sound = !sound; store.set('fa_sound', sound); updSnd(); beep(); };
updSnd();

/* ---------- Camera & tracking (all local) ---------- */
const AI = {}, cam = { on: false, stream: null };
const inp = { x: .5, y: 0, smile: false, jump: false, palm: false, fist: false, blink: false, seen: false };
let base = null, loopId = 0;
const keys = {};
let errMsg = '', loadMsg = 'Getting ready…';
const status = m => { $('#status').textContent = m; };
const updCam = () => {};

async function loadAI(hand) {
  if (hand) {
    if (AI.hand) return;
    const m = await import(MP + '/+esm');
    const fs = await m.FilesetResolver.forVisionTasks(MP + '/wasm');
    AI.hand = await m.HandLandmarker.createFromOptions(fs, {
      baseOptions: { modelAssetPath: HAND_MODEL }, runningMode: 'VIDEO', numHands: 1
    });
  } else if (!AI.face) {
    if (typeof faceapi === 'undefined') throw new Error('face-api.js failed to load (check your internet connection).');
    await Promise.all([faceapi.nets.tinyFaceDetector, faceapi.nets.faceLandmark68Net, faceapi.nets.faceExpressionNet].map(n => n.loadFromUri(MODEL_URL)));
    AI.face = 1;
  }
}

async function whyDenied() { // work out WHY permission was denied and say how to fix it
  if (location.protocol === 'file:') return 'The page was opened as a plain file, and some browsers block the camera that way. Run it from http://localhost (python -m http.server) and open that address.';
  if (window.top !== window.self) return 'This page is embedded inside another page (like a preview), which blocks the camera. Download the three files and open them from http://localhost.';
  let s = ''; try { s = (await navigator.permissions.query({ name: 'camera' })).state; } catch {}
  if (s === 'denied') return 'The camera is blocked for this site. Click the lock or camera icon in the address bar, set Camera to Allow, then reload the page. Also check that your system privacy settings let the browser use the camera.';
  return 'Camera permission was not granted. Press Start again and click Allow when asked. Also check your system privacy settings and that no other app is using the camera.';
}
async function startCam() {
  if (cam.on) return true;
  if (!navigator.mediaDevices?.getUserMedia) {
    errMsg = 'This browser or page cannot use the camera. Run the files from http://localhost (for example python -m http.server) or HTTPS in Chrome, Edge, Firefox or Safari.'; status(errMsg);
    return false;
  }
  try {
    status('Requesting camera… allow access when your browser asks.'); loadMsg = 'Allow camera access in your browser…';
    cam.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
    vid.srcObject = cam.stream; await vid.play();
    cam.on = true; vid.classList.add('show'); $('#trk').classList.add('show'); updCam();
    status('Loading AI models (first time only)…'); loadMsg = 'Loading AI models… (a few seconds)';
    await loadAI(cur.hand);
    status('Tracking ready. Look at the camera and use the Recenter button if controls feel off.');
    track();
    return true;
  } catch (e) {
    const msgs = {
      NotAllowedError: 'Camera permission was denied. Click the camera icon in the address bar and allow access. If this page is embedded in another page or opened as a plain file, run it from http://localhost instead.',
      NotFoundError: 'No camera was found. Connect one, or play with the keyboard.',
      NotReadableError: 'Another app is using the camera. Close it and try again.'
    };
    stopCam();
    errMsg = e.name === 'NotAllowedError' ? await whyDenied() : (msgs[e.name] || ('Could not start tracking: ' + e.message + ' (the AI models load from a CDN, so check your internet connection).')); status(errMsg);
    return false;
  }
}
function stopCam() {
  loopId++; cam.on = false;
  cam.stream?.getTracks().forEach(t => t.stop());
  cam.stream = null; vid.srcObject = null; vid.classList.remove('show'); $('#trk').classList.remove('show');
  inp.seen = false; updCam();
}
async function track() {
  const id = ++loopId;
  while (cam.on && id === loopId) {
    try { if (vid.readyState >= 2) await (cur.hand ? handStep() : faceStep()); } catch (e) { console.warn(e); }
    await new Promise(r => requestAnimationFrame(r));
  }
}
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const trkClear = () => { const t = $('#trk'); t.getContext('2d').clearRect(0, 0, t.width, t.height); };
function lost() { inp.seen = false; inp.jump = inp.smile = inp.fist = inp.palm = false; trkClear(); }
function trkDraw(pts, big) { // dots over the camera preview so you can see tracking work
  const t = $('#trk'); if (t.width !== vid.videoWidth) { t.width = vid.videoWidth; t.height = vid.videoHeight; }
  const c = t.getContext('2d'); c.clearRect(0, 0, t.width, t.height); c.fillStyle = '#4de3b0';
  pts.forEach(p => { c.beginPath(); c.arc(p.x, p.y, 3, 0, 7); c.fill(); });
  c.fillStyle = '#ff6fb5'; c.beginPath(); c.arc(big.x, big.y, 9, 0, 7); c.fill();
}
async function faceStep() {
  const r = await faceapi.detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: .3 })).withFaceLandmarks().withFaceExpressions();
  if (!r) return lost();
  const p = r.landmarks.positions, n = p[30];
  trkDraw(p, n);
  const rx = 1 - n.x / vid.videoWidth, ry = n.y / vid.videoHeight; // mirrored nose tip
  if (!base) base = { x: rx, y: ry };
  inp.x += (clamp(.5 + (rx - base.x) * 5, 0, 1) - inp.x) * .6;
  inp.y = clamp((ry - base.y) * 8, -1, 1);
  inp.jump = inp.y < -.4;
  inp.smile = r.expressions.happy > .6;
  const ear = (a, b, c, d, e, f) => (dist(p[b], p[f]) + dist(p[c], p[e])) / (2 * dist(p[a], p[d]));
  inp.blink = (ear(36, 37, 38, 39, 40, 41) + ear(42, 43, 44, 45, 46, 47)) / 2 < .2;
  inp.seen = true;
}
async function handStep() {
  const l = AI.hand.detectForVideo(vid, performance.now()).landmarks[0];
  if (!l) return lost();
  const vw = vid.videoWidth, vh = vid.videoHeight;
  trkDraw(l.map(q => ({ x: q.x * vw, y: q.y * vh })), { x: l[9].x * vw, y: l[9].y * vh });
  const d = (a, b) => dist(l[a], l[b]);
  const ext = [[8, 6], [12, 10], [16, 14], [20, 18]].filter(([t, q]) => d(t, 0) > d(q, 0) * 1.1).length;
  inp.x += (clamp(.5 + ((1 - l[9].x) - .5) * 1.8, 0, 1) - inp.x) * .6;
  inp.y = clamp((l[9].y - .5) * 2, -1, 1);
  inp.jump = l[9].y < .38;
  inp.palm = ext >= 4; inp.fist = ext === 0; inp.seen = true;
}
let kx = .5, ky = 0, ptr = null, pDown = 0; // ptr = mouse/touch position over the game (0..1)
cv.addEventListener('pointermove', e => { const r = cv.getBoundingClientRect(); ptr = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; });
cv.addEventListener('pointerdown', e => { const r = cv.getBoundingClientRect(); ptr = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }; pDown = performance.now(); });
addEventListener('pointerup', () => pDown = 0);
function ctl(dt) {
  if (cam.on) return inp; // camera on: only your face/hand controls the game
  const kd = (keys.ArrowRight ? 1 : 0) - (keys.ArrowLeft ? 1 : 0), kv = (keys.ArrowDown ? 1 : 0) - (keys.ArrowUp ? 1 : 0);
  if (kd || kv) ptr = null; // keyboard takes over from the pointer
  kx = clamp(kx + kd * dt * .8, 0, 1); ky = clamp(ky + kv * dt * 1.5, -1, 1);
  const tap = !!pDown, hold = tap && performance.now() - pDown > 450; // tap = jump/boost, hold = fist/dash
  if (ptr) return { x: clamp(ptr.x, 0, 1), y: clamp((ptr.y - .5) * 2, -1, 1), smile: !!keys.KeyS || tap, jump: !!keys.ArrowUp || tap, fist: !!keys.Space || hold, palm: false };
  return { x: kx, y: ky, smile: !!keys.KeyS, jump: !!keys.ArrowUp, fist: !!keys.Space, palm: false };
}
addEventListener('keydown', e => {
  keys[e.code] = 1;
  if (e.code === 'KeyP') togglePause();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && !$('#gameView').hidden) e.preventDefault();
});
addEventListener('keyup', e => keys[e.code] = 0);

/* ---------- Game framework ---------- */
let cur = null, st = 'idle', score = 0, lives = 3, el = 0, cd = 0, D = LV.normal, S = null, best = 0, msg = '', shake = 0, last = 0;
const G = {};
const add = n => score += n;
const em = (t, x, y, s = 40) => { ctx.font = s + 'px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, x, y); };
const sky = (a, b) => { const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, a); g.addColorStop(1, b); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H); };

function reset() {
  D = LV[$('#diff').value]; score = 0; lives = D.l; el = 0; shake = 0;
  cur.init(); best = store.get('fa_best_' + cur.id, 0);
}
function open(id) {
  cur = G[id]; $('#home').hidden = true; $('#gameView').hidden = false;
  $('#gTitle').textContent = cur.title; $('#help').textContent = '🎮 ' + cur.help;
  status('Press Start. The camera turns on when you start (it never records).');
  reset(); setSt('idle'); scrollTo(0, 0);
}
function leave() {
  stopCam(); cur = null; st = 'idle';
  $('#gameView').hidden = true; $('#home').hidden = false;
}
function setSt(s) {
  st = s; const o = $('#ov');
  o.hidden = s === 'playing' || s === 'countdown';
  const b = t => `<button id="ovGo">${t}</button>`;
  if (s === 'idle') o.innerHTML = `<h2>${cur.title}</h2><p>${cur.help}</p><p>Look straight at the camera when the countdown ends. Video stays on your device.</p>${b('▶ Start')}`;
  if (s === 'paused') o.innerHTML = `<h2>⏸ Paused</h2>${b('▶ Resume')}`;
  if (s === 'over') o.innerHTML = `<h2>${msg}</h2><p>Score ${score} · Best ${best}</p>${b('↻ Play again')}`;
  if (s === 'error') o.innerHTML = `<h2>📷 Camera not working</h2><p>${errMsg}</p>${b('↻ Retry camera')}<button id="ovNo" class="chip">Play with mouse/keyboard instead</button>`;
  const nb = $('#ovNo'); if (nb) nb.onclick = () => { setSt('countdown'); cd = 3; };
  const g = $('#ovGo'); if (g) g.onclick = s === 'paused' ? togglePause : startGame;
  $('#bPause').textContent = s === 'paused' ? '▶ Resume' : '⏸ Pause';
}
async function startGame() {
  if (!cur) return;
  reset(); cd = Infinity; setSt('countdown');
  loadMsg = 'Getting ready…';
  const ok = await startCam();
  if (!cur || st !== 'countdown') return;
  if (!ok) { setSt('error'); return; }
  cd = 3;
}
function togglePause() {
  if (!cur) return;
  if (st === 'playing') setSt('paused'); else if (st === 'paused') setSt('playing');
}
function end(m) {
  msg = m;
  if (score > best) { best = score; store.set('fa_best_' + cur.id, best); msg += ' 🏆 New best!'; }
  setSt('over'); beep(200, .5, 'sawtooth');
}
function hit() {
  lives--; shake = .3; beep(160, .25, 'square');
  if (lives <= 0) end('💥 Game over');
}
let pt = 0, armed = true, ppx = 0;
function palmPause(dt) { // hold an open palm still for ~1s to pause/resume
  if (!(cur.hand && cam.on && inp.seen && (st === 'playing' || st === 'paused'))) return;
  const still = Math.abs(inp.x - ppx) / dt < .25; ppx = inp.x;
  if (!inp.palm) { armed = true; pt = 0; }
  else if (armed && still) { pt += dt; if (pt > 1.1) { togglePause(); armed = false; pt = 0; } }
  else pt = 0;
}
function frame(ts) {
  const dt = Math.min(.05, (ts - last) / 1000 || 0); last = ts;
  if (cur) {
    const c = ctl(dt);
    if (st === 'countdown' && cd !== Infinity) { cd -= dt; if (cd <= 0) { setSt('playing'); base = null; beep(900, .2); } }
    else if (st === 'playing') {
      cur.update(dt, c); el += dt; shake = Math.max(0, shake - dt);
      if (cur.limit && el >= cur.limit && st === 'playing') end("⏰ Time's up!");
    }
    palmPause(dt);
    ctx.save();
    if (shake > 0) ctx.translate(rnd(-5, 5), rnd(-5, 5));
    cur.draw(); ctx.restore();
    if (st === 'countdown') {
      ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#fff';
      em(cd === Infinity ? loadMsg : Math.ceil(cd), W / 2, H / 2, cd === Infinity ? 28 : 120);
    }
    if (st === 'playing' && !(cam.on && inp.seen)) {
      ctx.fillStyle = 'rgba(43,35,80,.8)'; ctx.fillRect(W / 2 - 330, 8, 660, 30);
      ctx.fillStyle = '#fff'; ctx.font = '15px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(cam.on ? 'No face/hand detected: move into the camera view (and make sure the room is lit)' : 'Camera off: move your mouse over the game (tap/click = jump, hold = dash) or use arrow keys', W / 2, 23);
    }
    $('#hScore').textContent = score; $('#hBest').textContent = Math.max(best, score);
    $('#hLives').textContent = lives;
    $('#hTime').textContent = cur.limit ? Math.max(0, Math.ceil(cur.limit - el)) : Math.floor(el);
    $('#live').textContent = !cam.on ? 'No camera' : inp.seen ? (cur.hand ? `✋ ${inp.fist ? 'fist' : inp.palm ? 'palm' : 'hand'}` : `Face ✓ ${inp.smile ? '😊' : '😐'}${inp.blink ? ' 😑' : ''}`) : 'Searching…';
  }
  requestAnimationFrame(frame);
}

/* ---------- Game 1: Catch the Stars ---------- */
G.stars = {
  id: 'stars', title: 'Catch the Stars', hand: false, limit: 60,
  help: 'Move your head left/right to run, tilt it up to jump, smile 😊 for 3 seconds of super speed. Catch ⭐, dodge ☄️. 60 seconds!',
  init() { S = { x: 400, y: 430, vy: 0, items: [], sp: 0, boost: 0, cool: 0, t: 0 }; },
  update(dt, c) {
    S.t += dt;
    if (c.smile && S.boost <= 0 && S.cool <= 0) { S.boost = 3; S.cool = 6; beep(900, .2); }
    S.boost -= dt; S.cool -= dt;
    S.x += (c.x * W - S.x) * Math.min(1, (S.boost > 0 ? 16 : 4) * dt);
    if (c.jump && S.y >= 430) { S.vy = -640; beep(500, .1); }
    S.vy += 1500 * dt; S.y = Math.min(430, S.y + S.vy * dt); if (S.y >= 430) S.vy = 0;
    if ((S.sp -= dt) <= 0) {
      S.sp = rnd(.45, .9) / D.s;
      S.items.push({ x: rnd(40, 760), y: -30, bad: Math.random() < .3, v: (rnd(130, 230) + el * 2) * D.s });
    }
    for (const i of S.items) {
      i.y += i.v * dt;
      if (Math.hypot(i.x - S.x, i.y - (S.y - 10)) < 44) { i.dead = 1; if (i.bad) hit(); else { add(S.boost > 0 ? 20 : 10); beep(880, .08); } }
      else if (i.y > H + 30) i.dead = 1;
    }
    S.items = S.items.filter(i => !i.dead);
  },
  draw() {
    sky('#2b2360', '#8a5cc7');
    ctx.fillStyle = '#fff'; for (let k = 0; k < 30; k++) ctx.fillRect((k * 97) % W, (k * 53 + S.t * 8) % 300, 2, 2);
    ctx.fillStyle = '#4de3b0'; ctx.fillRect(0, 462, W, 40);
    for (const i of S.items) em(i.bad ? '☄️' : '⭐', i.x, i.y, 38);
    if (S.boost > 0) { ctx.fillStyle = 'rgba(255,212,71,.4)'; ctx.beginPath(); ctx.arc(S.x, S.y, 46 + Math.sin(S.t * 20) * 4, 0, 7); ctx.fill(); }
    em('🐱', S.x, S.y, 56);
    if (S.boost > 0) em('🔥', S.x - 36, S.y + 10, 26);
    ctx.fillStyle = '#fff'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(S.boost > 0 ? '⚡ SUPER SPEED' : S.cool > 0 ? 'Recharging…' : '😊 Smile for speed', 12, 24);
  }
};

/* ---------- Game 2: Flappy Face ---------- */
G.fly = {
  id: 'fly', title: 'Flappy Face', hand: false,
  help: 'Move your head up/down to steer the bird through the pipes. Smile 😊 for a short upward boost. Each pipe = 10 points.',
  init() { S = { y: 250, vy: 0, pipes: [], sp: 0, inv: 0, bc: 0, t: 0 }; },
  update(dt, c) {
    S.t += dt; S.inv -= dt; S.bc -= dt;
    if (c.smile && S.bc <= 0) { S.vy = -520; S.bc = 1.5; beep(1000, .15); }
    S.y += (clamp(250 + c.y * 250, 30, 470) - S.y) * Math.min(1, 6 * dt) + S.vy * dt;
    S.vy *= Math.pow(.01, dt); S.y = clamp(S.y, 20, 480);
    const v = 200 * D.s, gap = 200 / Math.sqrt(D.s);
    if ((S.sp -= dt) <= 0) { S.pipes.push({ x: W + 40, gy: rnd(gap / 2 + 40, H - gap / 2 - 40), gap }); S.sp = 420 / v; }
    for (const p of S.pipes) {
      p.x -= v * dt;
      if (!p.pass && p.x + 30 < 160) { p.pass = 1; add(10); beep(700, .08); }
      if (Math.abs(p.x - 160) < 46 && (S.y < p.gy - p.gap / 2 + 8 || S.y > p.gy + p.gap / 2 - 8) && S.inv <= 0) { S.inv = 1.5; hit(); }
    }
    S.pipes = S.pipes.filter(p => p.x > -60);
  },
  draw() {
    sky('#7fd4ff', '#e6f7ff');
    ctx.fillStyle = '#fff'; for (let k = 0; k < 4; k++) em('☁️', ((k * 260 - S.t * 30) % 1000 + 1000) % 1000 - 100, 60 + k * 50, 70);
    for (const p of S.pipes) {
      ctx.fillStyle = '#3ecf8e';
      ctx.fillRect(p.x - 30, 0, 60, p.gy - p.gap / 2); ctx.fillRect(p.x - 30, p.gy + p.gap / 2, 60, H);
      ctx.fillStyle = '#25a86e';
      ctx.fillRect(p.x - 38, p.gy - p.gap / 2 - 20, 76, 20); ctx.fillRect(p.x - 38, p.gy + p.gap / 2, 76, 20);
    }
    if (S.inv <= 0 || Math.floor(S.t * 10) % 2) em(S.bc > 1.2 ? '🚀' : '🐦', 160, S.y, 48);
    ctx.fillStyle = '#2b2350'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(S.bc > 0 ? 'Boost recharging…' : '😊 Smile for a boost', 12, 24);
  }
};

/* ---------- Game 3: Gesture Jumper ---------- */
G.jump = {
  id: 'jump', title: 'Gesture Jumper', hand: true,
  help: 'Move your hand left/right to run, raise it high to jump, make a fist ✊ to dash through obstacles. Hold an open palm ✋ still for 1 second to pause.',
  init() { S = { x: 200, y: 420, vy: 0, obs: [], coins: [], sp: 1, dash: 0, dc: 0, inv: 0, t: 0 }; },
  update(dt, c) {
    S.t += dt; S.inv -= dt; S.dc -= dt;
    S.x += (40 + c.x * 720 - S.x) * Math.min(1, 8 * dt);
    if (c.jump && S.y >= 420) { S.vy = -720; beep(520, .1); }
    S.vy += 1800 * dt; S.y = Math.min(420, S.y + S.vy * dt); if (S.y >= 420) S.vy = 0;
    if (c.fist && S.dash <= 0 && S.dc <= 0) { S.dash = .6; S.dc = 2; beep(300, .2, 'sawtooth'); }
    S.dash -= dt;
    const v = (260 + el * 5) * D.s * (S.dash > 0 ? 2 : 1);
    if ((S.sp -= dt) <= 0) {
      S.sp = rnd(.9, 1.8) / D.s;
      S.obs.push({ x: W + 40, w: rnd(34, 60), h: rnd(40, 80) });
      if (Math.random() < .6) S.coins.push({ x: W + 40 + rnd(80, 200), y: rnd(240, 390) });
    }
    for (const o of S.obs) {
      o.x -= v * dt;
      const ov = S.x + 18 > o.x && S.x - 18 < o.x + o.w && S.y > 460 - o.h;
      if (ov && !o.dead) {
        if (S.dash > 0) { o.dead = 1; add(15); beep(700, .1); }
        else if (S.inv <= 0) { S.inv = 1.2; hit(); }
      }
    }
    for (const k of S.coins) {
      k.x -= v * dt;
      if (Math.hypot(k.x - S.x, k.y - (S.y - 20)) < 36) { k.dead = 1; add(5); beep(1100, .06); }
    }
    S.obs = S.obs.filter(o => o.x > -80 && !o.dead); S.coins = S.coins.filter(k => k.x > -40 && !k.dead);
    S.acc = (S.acc || 0) + dt; if (S.acc >= 1) { S.acc -= 1; add(1); } // +1 per second survived
  },
  draw() {
    sky('#ffb8dd', '#ffe9b8');
    ctx.fillStyle = '#e59ac4'; for (let k = 0; k < 8; k++) ctx.fillRect(k * 120 + 20, 300 - (k % 3) * 40, 70, 160 + (k % 3) * 40);
    ctx.fillStyle = '#7a5cc7'; ctx.fillRect(0, 460, W, 40);
    for (const o of S.obs) { ctx.fillStyle = '#ff5a7a'; ctx.fillRect(o.x, 460 - o.h, o.w, o.h); em('🌵', o.x + o.w / 2, 460 - o.h - 6, 34); }
    for (const k of S.coins) em('🪙', k.x, k.y, 30);
    if (S.dash > 0) { ctx.fillStyle = 'rgba(255,255,255,.7)'; for (let k = 0; k < 5; k++) ctx.fillRect(S.x - 40 - k * 30, S.y - 50 + k * 10, 36, 4); }
    if (S.inv <= 0 || Math.floor(S.t * 12) % 2) em(S.dash > 0 ? '💨' : '🐰', S.x, S.y - 22, 52);
    ctx.fillStyle = '#2b2350'; ctx.font = '16px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(S.dc > 0 ? 'Dash recharging…' : '✊ Fist to dash', 12, 24);
  }
};

/* ---------- UI wiring ---------- */
document.querySelectorAll('.card').forEach(c => {
  c.onclick = () => open(c.dataset.g);
  c.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(c.dataset.g); } };
});
$('#playNow').onclick = () => $('#games').scrollIntoView({ behavior: 'smooth' });
$('#backBtn').onclick = leave;
$('#bStart').onclick = $('#bRestart').onclick = startGame;
$('#bPause').onclick = togglePause;
$('#bCal').onclick = () => { base = null; status('Recentered. Hold your natural position for a moment.'); };
$('#diff').onchange = () => { if (cur) { reset(); setSt('idle'); } };
document.addEventListener('visibilitychange', () => { if (document.hidden && st === 'playing') togglePause(); });
addEventListener('pagehide', stopCam);
const bg = $('#bg');
['⭐', '🎮', '💖', '🌈', '😄', '🍭', '🎈', '✨'].forEach((e, i) => {
  for (let k = 0; k < 2; k++) {
    const s = document.createElement('span');
    s.textContent = e; s.style.left = (i * 12.5 + k * 6 + rnd(0, 4)) + '%';
    s.style.animationDuration = rnd(14, 28) + 's'; s.style.animationDelay = -rnd(0, 20) + 's';
    bg.appendChild(s);
  }
});
requestAnimationFrame(frame);
