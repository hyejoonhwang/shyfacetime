// ============================================================
// ShyFaceTime — client
// ============================================================

firebase.initializeApp({
  apiKey: "AIzaSyAe9ibfaDm5HSwIUa6cRGZb49pM12UE_sk",
  authDomain: "shyfacetime.firebaseapp.com",
  projectId: "shyfacetime",
  storageBucket: "shyfacetime.firebasestorage.app",
  messagingSenderId: "589806884919",
  appId: "1:589806884919:web:053db2d977f57095a807b2"
});

const auth = firebase.auth();
const googleProvider = new firebase.auth.GoogleAuthProvider();
const socket = io();

// --- DOM refs ---
const loginScreen = document.getElementById('login-screen');
const waitingScreen = document.getElementById('waiting-screen');
const connectingScreen = document.getElementById('connecting-screen');
const callScreen = document.getElementById('call-screen');
const googleSigninBtn = document.getElementById('google-signin-btn');
const signoutBtn = document.getElementById('signout-btn');
const myPhoto = document.getElementById('my-photo');
const myNameEl = document.getElementById('my-name');
const waitingEmpty = document.getElementById('waiting-empty');
const hangupBtn = document.getElementById('hangup-btn');
const muteBtn = document.getElementById('mute-btn');
const speakerBtn = document.getElementById('speaker-btn');
const gazeDebug = document.getElementById('gaze-debug');

// Connecting screen refs
const connectingTitle = document.getElementById('connecting-title');
const connectMyPhoto = document.getElementById('connect-my-photo');
const connectMyName = document.getElementById('connect-my-name');
const connectTheirPhoto = document.getElementById('connect-their-photo');
const connectTheirName = document.getElementById('connect-their-name');
const connectingActions = document.getElementById('connecting-actions');
const connectAcceptBtn = document.getElementById('connect-accept-btn');
const connectDeclineBtn = document.getElementById('connect-decline-btn');
const connectingStatus = document.getElementById('connecting-status');

// --- State ---
let currentUser = null;
let myName = '';
let myPhoto_url = '';
let mySocketId = null;
let userListCache = [];
let partnerId = null;
let pendingCallerId = null;
let localStream = null;
let p5lm = null;
let remoteVideo = null;
let p5Instance = null;
let faceMesh = null;
let lookScore = 1;
let isMuted = false;
let partnerLookScore = 0; // what the other person's gaze says about how they see me
let lastGazeSendTime = 0;

// --- Helpers ---
function showScreen(screen) {
  [loginScreen, waitingScreen, connectingScreen, callScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ============================================================
// 1. FIREBASE AUTH
// ============================================================

googleSigninBtn.addEventListener('click', () => {
  auth.signInWithPopup(googleProvider).catch(err => console.error('Sign-in error:', err));
});

signoutBtn.addEventListener('click', () => auth.signOut());

auth.onAuthStateChanged((user) => {
  if (user) {
    currentUser = user;
    myName = user.displayName || 'Anonymous';
    myPhoto_url = user.photoURL || '';
    myNameEl.textContent = myName;
    myPhoto.src = myPhoto_url;
    showScreen(waitingScreen);
    socket.emit('join', { name: myName, photo: myPhoto_url });
  } else {
    currentUser = null;
    myName = '';
    myPhoto_url = '';
    showScreen(loginScreen);
  }
});

socket.on('connect', () => {
  mySocketId = socket.id;
  if (currentUser) {
    socket.emit('join', { name: myName, photo: myPhoto_url });
  }
});

// ============================================================
// 2. WAITING ROOM
// ============================================================

socket.on('waiting-list', (list) => {
  userListCache = list;
  renderUserGrid(list);
});

function renderUserGrid(list) {
  const others = list.filter(u => u.id !== mySocketId);
  const userGrid = document.getElementById('user-grid');
  const waitingEmpty = document.getElementById('waiting-empty');
  userGrid.innerHTML = '';

  if (others.length === 0) {
    waitingEmpty.style.display = 'block';
    return;
  }
  waitingEmpty.style.display = 'none';

  others.forEach(user => {
    const card = document.createElement('div');
    card.className = 'user-card';
    card.innerHTML = `
      <img src="${escapeAttr(user.photo)}" alt="" class="avatar-md">
      <span class="user-name">${escapeHtml(user.name)}</span>
      <span class="user-status">online</span>
      <button class="btn btn-primary btn-sm" onclick="requestCall('${user.id}')">call</button>
    `;
    userGrid.appendChild(card);
  });
}

window.requestCall = function(targetId) {
  const target = userListCache.find(u => u.id === targetId);
  connectMyPhoto.src = myPhoto_url;
  connectMyName.textContent = myName;
  connectTheirPhoto.src = target ? target.photo : '';
  connectTheirName.textContent = target ? target.name : 'Someone';
  connectingTitle.textContent = 'calling...';
  connectingActions.classList.add('hidden');
  connectingStatus.classList.remove('hidden');
  connectingStatus.textContent = 'waiting for them to accept...';
  showScreen(connectingScreen);
  socket.emit('call-request', targetId);
};

// --- Incoming call → show connecting screen as responder ---
socket.on('incoming-call', (data) => {
  pendingCallerId = data.callerId;

  connectMyPhoto.src = myPhoto_url;
  connectMyName.textContent = myName;
  connectTheirPhoto.src = data.callerPhoto || '';
  connectTheirName.textContent = data.callerName;
  connectingTitle.textContent = 'incoming call';
  connectingActions.classList.remove('hidden');
  connectingStatus.classList.add('hidden');
  showScreen(connectingScreen);
});

connectAcceptBtn.addEventListener('click', () => {
  connectingActions.classList.add('hidden');
  connectingStatus.classList.remove('hidden');
  connectingStatus.textContent = 'connecting...';
  socket.emit('call-accept', pendingCallerId);
});

connectDeclineBtn.addEventListener('click', () => {
  pendingCallerId = null;
  showScreen(waitingScreen);
  socket.emit('call-decline', pendingCallerId);
});

socket.on('call-declined', () => {
  showScreen(waitingScreen);
});

// Receive partner's gaze score — controls blur on my local preview
socket.on('partner-gaze-score', (score) => {
  partnerLookScore = score;
});

// ============================================================
// 3. CALL SETUP (p5LiveMedia)
// ============================================================

socket.on('call-started', async (data) => {
  partnerId = data.partnerId;
  const roomName = data.room;
  console.log('Call started, joining room:', roomName);
  showScreen(callScreen);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not access camera/microphone');
    return;
  }

  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;

  startFaceMesh(localStream);

  if (!sketchInstance._elements) sketchInstance._elements = [];
  const host = window.location.origin;
  console.log('Creating p5LiveMedia for room:', roomName, 'host:', host);
  p5lm = new p5LiveMedia(sketchInstance, "CAPTURE", localStream, roomName, host);

  p5lm.on('stream', (stream, id) => {
    console.log('p5LiveMedia stream event!', id);
    const videoEl = stream.elt || stream;
    remoteVideo = videoEl;
    startP5(videoEl);
  });

  p5lm.on('disconnect', (id) => console.log('p5LiveMedia: peer disconnected', id));
  p5lm.on('connect', (id) => console.log('p5LiveMedia: connected, id:', id));
});

// ============================================================
// 4. CALL CONTROLS
// ============================================================

hangupBtn.addEventListener('click', hangUp);

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.style.background = isMuted ? 'var(--control-danger)' : 'var(--bg-secondary)';
  muteBtn.style.color = isMuted ? '#fff' : 'var(--typo-primary)';
});

speakerBtn.addEventListener('click', () => {
  // Toggle speaker (visual only — actual routing depends on device)
  speakerBtn.classList.toggle('active');
});

socket.on('partner-hung-up', () => {
  cleanUpCall();
  showScreen(waitingScreen);
  socket.emit('join', { name: myName, photo: myPhoto_url });
});

function hangUp() {
  socket.emit('hang-up');
  cleanUpCall();
  showScreen(waitingScreen);
  socket.emit('join', { name: myName, photo: myPhoto_url });
}

function cleanUpCall() {
  try { if (p5lm) p5lm.disconnect(-1); } catch (e) {}
  p5lm = null;
  if (p5Instance) { p5Instance.remove(); p5Instance = null; }
  if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
  try { if (faceMesh && typeof faceMesh.detectStop === 'function') faceMesh.detectStop(); } catch (e) {}
  if (frameLoopId) { cancelAnimationFrame(frameLoopId); frameLoopId = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  trackCanvas = null; trackCtx = null;
  document.querySelectorAll('video[style*="-9999"], audio').forEach(el => {
    if (el.id !== 'local-video') el.remove();
  });
  const lv = document.getElementById('local-video');
  if (lv) lv.srcObject = null;
  remoteVideo = null; partnerId = null; lookScore = 1; partnerLookScore = 1; isMuted = false;
  muteBtn.style.background = ''; muteBtn.style.color = '';
}

// ============================================================
// 5. FACE MESH (gaze detection)
// ============================================================

let trackCanvas = null;
let trackCtx = null;
let faceMeshReady = false;
let noFaceCount = 0;
let frameLoopId = null;
let lastResultTime = 0;
let watchdogId = null;

let sketchInstance = null;
let faceMeshPreloader = new p5((p) => {
  sketchInstance = p;
  p.preload = function () {
    console.log('Preloading faceMesh model...');
    faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: true, flipped: false });
  };
  p.setup = function () {
    p.noCanvas();
    faceMeshReady = true;
    console.log('FaceMesh preloaded, detectStart:', typeof faceMesh.detectStart);
  };
  p.draw = function () {};
});

function startFaceMesh(stream) {
  gazeDebug.textContent = 'setting up...';
  noFaceCount = 0; lastResultTime = 0;

  trackCanvas = document.createElement('canvas');
  trackCanvas.width = 320; trackCanvas.height = 240;
  trackCtx = trackCanvas.getContext('2d', { willReadFrequently: true });

  const localVid = document.getElementById('local-video');

  function drawFrame() {
    if (!trackCanvas) return;
    if (localVid.readyState >= 2) trackCtx.drawImage(localVid, 0, 0, 320, 240);
    frameLoopId = requestAnimationFrame(drawFrame);
  }

  function waitForVideo() {
    if (localVid.readyState >= 2 && localVid.videoWidth > 0) {
      gazeDebug.textContent = 'video ready...';
      drawFrame();
      setTimeout(() => {
        (function waitForModel() {
          if (faceMeshReady && faceMesh && typeof faceMesh.detectStart === 'function') {
            startDetection();
          } else {
            gazeDebug.textContent = 'loading model...';
            setTimeout(waitForModel, 300);
          }
        })();
      }, 500);
    } else {
      setTimeout(waitForVideo, 300);
    }
  }

  function startDetection() {
    if (!faceMesh || !faceMeshReady) return;
    lastResultTime = Date.now();
    gazeDebug.textContent = 'detecting...';
    faceMesh.detectStart(trackCanvas, onFaceResults);
    clearInterval(watchdogId);
    watchdogId = setInterval(() => {
      if (!faceMeshReady) { clearInterval(watchdogId); return; }
      if (Date.now() - lastResultTime > 3000) {
        gazeDebug.textContent = 'restarting...';
        faceMesh.detectStop();
        setTimeout(() => {
          lastResultTime = Date.now();
          faceMesh.detectStart(trackCanvas, onFaceResults);
        }, 500);
      }
    }, 2000);
  }

  waitForVideo();
}

function onFaceResults(results) {
  lastResultTime = Date.now();
  if (!results || results.length === 0) {
    noFaceCount++; lookScore = 1; // no face detected = assume looking at screen = blur
    gazeDebug.textContent = `no face (${noFaceCount})`;
    return;
  }
  noFaceCount = 0;
  const kp = results[0].keypoints;

  if (kp.length > 468) {
    const lO = kp[33], lI = kp[133], lIr = kp[468];
    const rI = kp[362], rO = kp[263], rIr = kp[473];
    const lW = Math.abs(lI.x - lO.x), rW = Math.abs(rO.x - rI.x);
    let lR = 0.5, rR = 0.5;
    if (lW > 1) lR = (lIr.x - Math.min(lO.x, lI.x)) / lW;
    if (rW > 1) rR = (rIr.x - Math.min(rO.x, rI.x)) / rW;
    const iDev = (Math.abs(lR - 0.5) + Math.abs(rR - 0.5)) / 2;
    const iScore = 1 - Math.min(iDev * 5, 1);
    const nose = kp[1], lC = kp[234], rC = kp[454];
    const fW = Math.abs(rC.x - lC.x), fCenter = (lC.x + rC.x) / 2;
    let hScore = 1;
    if (fW > 1) hScore = 1 - Math.min(Math.abs(nose.x - fCenter) / fW * 4, 1);
    lookScore = iScore * 0.6 + hScore * 0.4;
    gazeDebug.textContent = `iris:${iScore.toFixed(2)} head:${hScore.toFixed(2)} → ${lookScore.toFixed(2)}`;
  } else {
    const nose = kp[1], lC = kp[234], rC = kp[454];
    const fW = Math.abs(rC.x - lC.x), fCenter = (lC.x + rC.x) / 2;
    let hScore = 1;
    if (fW > 1) hScore = 1 - Math.min(Math.abs(nose.x - fCenter) / fW * 3, 1);
    const fH = Math.abs(kp[152].y - kp[10].y);
    const nV = (nose.y - kp[10].y) / fH;
    const vScore = 1 - Math.min(Math.abs(nV - 0.65) * 3, 1);
    lookScore = hScore * 0.7 + vScore * 0.3;
    gazeDebug.textContent = `head:${hScore.toFixed(2)} vert:${vScore.toFixed(2)} → ${lookScore.toFixed(2)}`;
  }
}

// ============================================================
// 6. P5 CANVAS — the core blur experience
// ============================================================

function startP5(remoteVideoEl) {
  if (p5Instance) return;
  p5Instance = new p5((p) => {
    let vidEl, blurAmount = 40, currentBlur = 40, canvasW, canvasH, canvasEl, isMobileDevice;

    let blurCanvas, blurCtx; // offscreen canvas for mobile blur

    p.setup = function () {
      canvasW = window.innerWidth; canvasH = window.innerHeight;
      const canvas = p.createCanvas(canvasW, canvasH);
      canvas.parent('canvas-container');
      canvasEl = canvas.elt;
      vidEl = remoteVideoEl;
      if (vidEl.play) { vidEl.autoplay = true; vidEl.playsInline = true; vidEl.play().catch(() => {}); }
      const audioEl = document.createElement('audio');
      audioEl.srcObject = vidEl.srcObject || vidEl.captureStream?.();
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEl.play().catch(() => {});
      isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

      // Test if ctx.filter actually works
      const testC = document.createElement('canvas');
      testC.width = 1; testC.height = 1;
      const testCtx = testC.getContext('2d');
      testCtx.filter = 'blur(1px)';
      const ctxFilterWorks = (testCtx.filter === 'blur(1px)');

      if (!ctxFilterWorks) {
        blurCanvas = document.createElement('canvas');
        blurCtx = blurCanvas.getContext('2d');
      }
    };

    p.draw = function () {
      p.background(0);
      if (!vidEl || vidEl.readyState < 2) {
        p.fill(100); p.textAlign(p.CENTER, p.CENTER); p.textSize(16);
        p.text('connecting...', canvasW / 2, canvasH / 2);
        return;
      }
      const targetBlur = lookScore * blurAmount;
      currentBlur = p.lerp(currentBlur, targetBlur, 0.12);

      // Send my lookScore to partner (throttled to ~10fps)
      const now = Date.now();
      if (now - lastGazeSendTime > 100) {
        socket.emit('gaze-score', lookScore);
        lastGazeSendTime = now;
      }

      // Local preview: blur based on PARTNER's lookScore (how they see me)
      const localVid = document.getElementById('local-video');
      if (localVid) {
        const partnerBlur = Math.round(partnerLookScore * blurAmount);
        localVid.style.filter = partnerBlur > 0 ? `blur(${partnerBlur}px)` : 'none';
      }
      const vr = vidEl.videoWidth / vidEl.videoHeight, cr = canvasW / canvasH;
      let dw, dh, dx, dy;
      if (vr > cr) { dh = canvasH; dw = canvasH * vr; } else { dw = canvasW; dh = canvasW / vr; }
      dx = (canvasW - dw) / 2; dy = (canvasH - dh) / 2;
      const ctx = p.drawingContext, blur = Math.round(currentBlur);
      ctx.save(); ctx.translate(canvasW, 0); ctx.scale(-1, 1);

      if (!blurCanvas) {
        // Desktop: ctx.filter works — blur inside canvas pixels
        ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
        ctx.drawImage(vidEl, dx, dy, dw, dh);
        ctx.filter = 'none';
      } else {
        // Mobile fallback: downscale/upscale on offscreen canvas
        if (blur > 2) {
          const scale = p.map(currentBlur, 0, blurAmount, 1, 0.04);
          const sw = Math.max(4, Math.round(dw * scale));
          const sh = Math.max(4, Math.round(dh * scale));
          blurCanvas.width = sw;
          blurCanvas.height = sh;
          blurCtx.imageSmoothingEnabled = true;
          blurCtx.imageSmoothingQuality = 'medium';
          blurCtx.drawImage(vidEl, 0, 0, sw, sh);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'medium';
          ctx.drawImage(blurCanvas, 0, 0, sw, sh, dx, dy, dw, dh);
        } else {
          ctx.drawImage(vidEl, dx, dy, dw, dh);
        }
      }

      ctx.restore();
      if (currentBlur > 5) {
        p.noStroke(); p.fill(10, 10, 10, p.map(currentBlur, 5, blurAmount, 0, 80));
        p.rect(0, 0, canvasW, canvasH);
      }
    };

    p.windowResized = function () {
      canvasW = window.innerWidth; canvasH = window.innerHeight;
      p.resizeCanvas(canvasW, canvasH);
    };
  });
}

// ============================================================
// UTILS
// ============================================================

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
