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
const appShell = document.getElementById('app-shell');
const googleSigninBtn = document.getElementById('google-signin-btn');
const signoutBtn = document.getElementById('signout-btn');
// sidebar-name removed — sign out is now a nav item
const topbarContext = document.getElementById('topbar-context');
const topbarClock = document.getElementById('topbar-clock');
const gazeDebug = document.getElementById('gaze-debug');

// Connecting refs
const connectingTitle = document.getElementById('connecting-title');
const connectMyName = document.getElementById('connect-my-name');
const connectTheirName = document.getElementById('connect-their-name');
const connectingActions = document.getElementById('connecting-actions');
const connectAcceptBtn = document.getElementById('connect-accept-btn');
const connectDeclineBtn = document.getElementById('connect-decline-btn');
const connectingStatus = document.getElementById('connecting-status');

// Call refs
const hangupBtn = document.getElementById('hangup-btn');
const muteBtn = document.getElementById('mute-btn');
const speakerBtn = document.getElementById('speaker-btn');

// --- State ---
let currentUser = null;
let myName = '';
let myPhoto_url = '';
let mySocketId = null;
let userListCache = [];
let partnerId = null;
let partnerName = '';
let pendingCallerId = null;
let localStream = null;
let p5lm = null;
let remoteVideo = null;
let p5Instance = null;
let faceMesh = null;
let lookScore = 1;
let partnerLookScore = 0; // clear until partner sends gaze data
let lastGazeSendTime = 0;
let isMuted = false;

// --- Init Lucide icons ---
document.addEventListener('DOMContentLoaded', () => {
  if (window.lucide) lucide.createIcons();
});

// --- Mobile hamburger menu ---
const hamburgerBtn = document.getElementById('hamburger-btn');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebar-overlay');

if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    sidebar.classList.toggle('open');
    sidebarOverlay.classList.toggle('open');
  });
}
if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
  });
}

// Close sidebar when nav item clicked (mobile)
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    sidebar.classList.remove('open');
    sidebarOverlay.classList.remove('open');
  });
});

// Close sidebar on sign out
signoutBtn.addEventListener('click', () => {
  sidebar.classList.remove('open');
  sidebarOverlay.classList.remove('open');
});

// --- Blur lens — follows mouse on landing page and shell ---
const blurLens = document.getElementById('blur-lens');
const blurLensShell = document.getElementById('blur-lens-shell');

function trackLens(lens, target) {
  if (!lens || !target) return;

  // Mouse (desktop)
  target.addEventListener('mousemove', (e) => {
    lens.style.left = e.clientX + 'px';
    lens.style.top = e.clientY + 'px';
  });

  // Touch (mobile) — show on touch, follow finger, hide on release
  target.addEventListener('touchstart', (e) => {
    lens.style.opacity = '1';
    lens.style.left = e.touches[0].clientX + 'px';
    lens.style.top = e.touches[0].clientY + 'px';
  }, { passive: true });

  target.addEventListener('touchmove', (e) => {
    lens.style.left = e.touches[0].clientX + 'px';
    lens.style.top = e.touches[0].clientY + 'px';
  }, { passive: true });

  target.addEventListener('touchend', () => {
    lens.style.opacity = '0';
  });
}

trackLens(blurLens, document.getElementById('login-screen'));
trackLens(blurLensShell, document);

// --- Clock ---
function updateClock() {
  const now = new Date();
  topbarClock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
updateClock();
setInterval(updateClock, 30000);

// ============================================================
// VIEW ROUTING
// ============================================================

function showView(viewId) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const view = document.getElementById('view-' + viewId);
  if (view) view.classList.add('active');

  // Update nav active state
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const navItem = document.querySelector(`.nav-item[data-view="${viewId}"]`);
  if (navItem) navItem.classList.add('active');

  // Update topbar context
  const labels = { about: 'shyfacetime', waiting: 'the room', echoes: 'echoes', mirror: 'the mirror', connecting: 'connecting...', call: `in a call with ${partnerName}` };
  topbarContext.textContent = labels[viewId] || '';

  // Collapse sidebar during call
  if (viewId === 'call') {
    appShell.classList.add('sidebar-collapsed');
  } else {
    appShell.classList.remove('sidebar-collapsed');
  }
}

// Sidebar nav clicks
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    if (item.dataset.view) showView(item.dataset.view);
  });
});

// Logo click → about page (both desktop sidebar and mobile topbar)
['logo-link', 'logo-link-mobile'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      showView('about');
    });
  }
});

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
    // name display removed from sidebar
    loginScreen.classList.remove('active');
    appShell.classList.remove('shell-hidden');
    showView('waiting');
    socket.emit('join', { name: myName, photo: myPhoto_url, uid: currentUser ? currentUser.uid : '' });
  } else {
    currentUser = null;
    myName = '';
    appShell.classList.add('shell-hidden');
    loginScreen.classList.add('active');
  }
});

socket.on('connect', () => {
  mySocketId = socket.id;
  if (currentUser) socket.emit('join', { name: myName, photo: myPhoto_url, uid: currentUser ? currentUser.uid : '' });
});

// ============================================================
// 2. WAITING ROOM
// ============================================================

let currentTab = 'nearby';
let familiarFaces = [];

socket.on('waiting-list', (list) => {
  userListCache = list;
  renderWaitingRoom();
});

// Search
const waitingSearch = document.getElementById('waiting-search');
if (waitingSearch) waitingSearch.addEventListener('input', () => renderWaitingRoom());

// Tabs
document.querySelectorAll('.waiting-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.waiting-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentTab = tab.dataset.tab;
    if (currentTab === 'familiar' && currentUser) socket.emit('get-history', currentUser.uid);
    renderWaitingRoom();
  });
});

// Receive familiar faces data
socket.on('history-data', (data) => {
  if (data.connections) {
    familiarFaces = data.connections.map(c => {
      const otherUid = c.user_a_uid === (currentUser ? currentUser.uid : '') ? c.user_b_uid : c.user_a_uid;
      return { uid: otherUid, totalCalls: c.total_calls, lastCallAt: c.last_call_at };
    });
  }
  if (data.history) renderEchoes(data.history);
  renderWaitingRoom();
});

function renderWaitingRoom() {
  const others = userListCache.filter(u => u.id !== mySocketId);
  const grid = document.getElementById('user-grid');
  const empty = document.getElementById('waiting-empty');
  if (!grid) return;

  const query = (waitingSearch ? waitingSearch.value : '').toLowerCase().trim();
  let filtered = others;

  if (query) filtered = filtered.filter(u => u.name.toLowerCase().includes(query));

  if (currentTab === 'familiar') {
    const familiarUids = new Set(familiarFaces.map(f => f.uid));
    filtered = filtered.filter(u => familiarUids.has(u.uid));
  }

  grid.innerHTML = '';

  if (filtered.length === 0) {
    empty.style.display = 'flex';
    const lg = empty.querySelector('.empty-text-lg');
    const sm = empty.querySelector('.empty-text-sm');
    if (currentTab === 'familiar' && others.length > 0) {
      lg.textContent = 'no familiar faces online';
      sm.textContent = 'call someone new to add them here';
    } else if (query) {
      lg.textContent = 'no one found';
      sm.textContent = '';
    } else {
      lg.textContent = "it's quiet right now";
      sm.textContent = 'you have the room to yourself';
    }
    return;
  }
  empty.style.display = 'none';

  filtered.forEach(user => {
    const card = document.createElement('div');
    card.className = 'user-card';
    const statusText = user.status || 'online';
    const arrivedAgo = user.joinedAt ? formatTimeAgo(user.joinedAt) : '';
    const familiar = familiarFaces.find(f => f.uid === user.uid);

    card.innerHTML = `
      <span class="user-name">${escapeHtml(user.name)}</span>
      <span class="user-status">${escapeHtml(statusText)}</span>
      ${arrivedAgo ? `<span class="user-arrived">arrived ${arrivedAgo}</span>` : ''}
      ${familiar ? `<span class="familiar-badge">${familiar.totalCalls} past call${familiar.totalCalls > 1 ? 's' : ''}</span>` : ''}
      <button class="btn btn-brand btn-sm" onclick="requestCall('${user.id}')">call</button>
    `;
    grid.appendChild(card);
  });
}

window.requestCall = function(targetId) {
  const target = userListCache.find(u => u.id === targetId);
  partnerName = target ? target.name : 'someone';
  connectMyName.textContent = myName;
  connectTheirName.textContent = partnerName;
  connectingTitle.textContent = 'calling...';
  connectingActions.classList.add('hidden');
  connectingStatus.classList.remove('hidden');
  connectingStatus.textContent = 'waiting for them to accept...';
  showView('connecting');
  socket.emit('call-request', targetId);
};

// Incoming call
socket.on('incoming-call', (data) => {
  pendingCallerId = data.callerId;
  partnerName = data.callerName;
  connectMyName.textContent = myName;
  connectTheirName.textContent = partnerName;
  connectingTitle.textContent = 'incoming call';
  connectingActions.classList.remove('hidden');
  connectingStatus.classList.add('hidden');
  showView('connecting');
});

connectAcceptBtn.addEventListener('click', () => {
  connectingActions.classList.add('hidden');
  connectingStatus.classList.remove('hidden');
  connectingStatus.textContent = 'connecting...';
  socket.emit('call-accept', pendingCallerId);
});

connectDeclineBtn.addEventListener('click', () => {
  socket.emit('call-decline', pendingCallerId);
  pendingCallerId = null;
  showView('waiting');
});

socket.on('call-declined', () => showView('waiting'));

// Partner gaze score
let partnerLookTarget = 0; // raw incoming value
let partnerBlurSmoothed = 0; // smoothed value for display

socket.on('partner-gaze-score', (score) => {
  partnerLookTarget = score;
});

// Smooth partner blur with requestAnimationFrame
function updatePartnerBlur() {
  partnerBlurSmoothed += (partnerLookTarget * 40 - partnerBlurSmoothed) * 0.08;
  const localVid = document.getElementById('local-video');
  if (localVid) {
    const pBlur = Math.round(partnerBlurSmoothed);
    localVid.style.filter = pBlur > 1 ? `blur(${pBlur}px)` : 'none';
  }
  requestAnimationFrame(updatePartnerBlur);
}
updatePartnerBlur();

// ============================================================
// 3. CALL SETUP (p5LiveMedia)
// ============================================================

socket.on('call-started', async (data) => {
  partnerId = data.partnerId;
  const roomName = data.room;
  console.log('Call started, room:', roomName);
  showView('call');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not access camera/microphone');
    return;
  }

  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;

  // Update label
  document.getElementById('my-video-label').textContent = 'me';

  startFaceMesh(localStream);

  if (!sketchInstance._elements) sketchInstance._elements = [];
  const host = window.location.origin;
  p5lm = new p5LiveMedia(sketchInstance, "CAPTURE", localStream, roomName, host);

  p5lm.on('stream', (stream, id) => {
    console.log('p5LiveMedia stream!', id);
    const videoEl = stream.elt || stream;
    remoteVideo = videoEl;
    document.getElementById('their-video-label').textContent = partnerName;
    startP5(videoEl);
  });

  p5lm.on('disconnect', (id) => console.log('Peer disconnected:', id));
  p5lm.on('connect', (id) => console.log('p5lm connected:', id));
});

// ============================================================
// 4. CALL CONTROLS
// ============================================================

hangupBtn.addEventListener('click', hangUp);

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  isMuted = !isMuted;
  localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  muteBtn.style.background = isMuted ? 'var(--danger)' : '';
  muteBtn.style.color = isMuted ? 'white' : '';
});

speakerBtn.addEventListener('click', () => speakerBtn.classList.toggle('active'));

socket.on('partner-hung-up', () => {
  cleanUpCall();
  showView('waiting');
  socket.emit('join', { name: myName, photo: myPhoto_url, uid: currentUser ? currentUser.uid : '' });
});

function hangUp() {
  socket.emit('hang-up');
  cleanUpCall();
  showView('waiting');
  socket.emit('join', { name: myName, photo: myPhoto_url, uid: currentUser ? currentUser.uid : '' });
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
  if (lv) { lv.srcObject = null; lv.style.filter = ''; }
  remoteVideo = null; partnerId = null; partnerName = '';
  lookScore = 1; partnerLookScore = 1; isMuted = false;
  faceEverDetected = false;
  muteBtn.style.background = ''; muteBtn.style.color = '';
}

// ============================================================
// 5. FACE MESH (gaze detection)
// ============================================================

let trackCanvas = null;
let trackCtx = null;
let faceMeshReady = false;
let noFaceCount = 0;
let faceEverDetected = false;
let frameLoopId = null;
let lastResultTime = 0;
let watchdogId = null;

let sketchInstance = null;
let faceMeshPreloader = new p5((p) => {
  sketchInstance = p;
  p.preload = function () {
    console.log('Preloading faceMesh...');
    faceMesh = ml5.faceMesh({ maxFaces: 1, refineLandmarks: true, flipped: false });
  };
  p.setup = function () {
    p.noCanvas();
    faceMeshReady = true;
    console.log('FaceMesh ready:', typeof faceMesh.detectStart);
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
        (function waitModel() {
          if (faceMeshReady && faceMesh && typeof faceMesh.detectStart === 'function') {
            startDetection();
          } else {
            gazeDebug.textContent = 'loading model...';
            setTimeout(waitModel, 300);
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
        setTimeout(() => { lastResultTime = Date.now(); faceMesh.detectStart(trackCanvas, onFaceResults); }, 500);
      }
    }, 2000);
  }

  waitForVideo();
}

function onFaceResults(results) {
  lastResultTime = Date.now();
  if (!results || results.length === 0) {
    noFaceCount++;
    lookScore = 1; // no face = assume looking at screen = blur
    gazeDebug.textContent = `no face (${noFaceCount})`;
    return;
  }
  noFaceCount = 0;
  const kp = results[0].keypoints;
  if (kp.length > 468) {
    const lO=kp[33],lI=kp[133],lIr=kp[468],rI=kp[362],rO=kp[263],rIr=kp[473];
    const lW=Math.abs(lI.x-lO.x),rW=Math.abs(rO.x-rI.x);
    let lR=0.5,rR=0.5;
    if(lW>1)lR=(lIr.x-Math.min(lO.x,lI.x))/lW;
    if(rW>1)rR=(rIr.x-Math.min(rO.x,rI.x))/rW;
    const iDev=(Math.abs(lR-0.5)+Math.abs(rR-0.5))/2;
    const iS=1-Math.min(iDev*8,1); // more sensitive to eye movement
    const n=kp[1],lC=kp[234],rC=kp[454];
    const fW=Math.abs(rC.x-lC.x),fC=(lC.x+rC.x)/2;
    let hS=1;
    if(fW>1)hS=1-Math.min(Math.abs(n.x-fC)/fW*4,1);
    lookScore=iS*0.85+hS*0.15; // iris dominant — eyes matter most
    gazeDebug.textContent=`iris:${iS.toFixed(2)} head:${hS.toFixed(2)} → ${lookScore.toFixed(2)}`;
  } else {
    const n=kp[1],lC=kp[234],rC=kp[454];
    const fW=Math.abs(rC.x-lC.x),fC=(lC.x+rC.x)/2;
    let hS=1;if(fW>1)hS=1-Math.min(Math.abs(n.x-fC)/fW*3,1);
    const fH=Math.abs(kp[152].y-kp[10].y),nV=(n.y-kp[10].y)/fH;
    const vS=1-Math.min(Math.abs(nV-0.65)*3,1);
    lookScore=hS*0.7+vS*0.3;
    gazeDebug.textContent=`head:${hS.toFixed(2)} vert:${vS.toFixed(2)} → ${lookScore.toFixed(2)}`;
  }
}

// ============================================================
// 6. P5 CANVAS — blur on their video
// ============================================================

function startP5(remoteVideoEl) {
  if (p5Instance) return;
  // Delay to let DOM layout settle (container needs dimensions)
  const container = document.getElementById('canvas-container');
  console.log('startP5 container:', container ? `${container.clientWidth}x${container.clientHeight}` : 'null');
  if (!container || container.clientWidth === 0) {
    setTimeout(() => startP5(remoteVideoEl), 200);
    return;
  }
  p5Instance = new p5((p) => {
    let vidEl, blurAmount = 40, currentBlur = 40, canvasEl;
    let cW, cH;

    let ctxFilterWorks = false;

    p.setup = function () {
      const container = document.getElementById('canvas-container');
      cW = container.clientWidth;
      cH = container.clientHeight;
      const canvas = p.createCanvas(cW, cH);
      canvas.parent('canvas-container');
      canvasEl = canvas.elt;

      vidEl = remoteVideoEl;
      if (vidEl.play) { vidEl.autoplay = true; vidEl.playsInline = true; vidEl.play().catch(() => {}); }

      const audioEl = document.createElement('audio');
      audioEl.srcObject = vidEl.srcObject || vidEl.captureStream?.();
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEl.play().catch(() => {});

      // Mobile browsers claim ctx.filter support but don't actually render it
      const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
      ctxFilterWorks = !isMobile;
      console.log('Using ctx.filter:', ctxFilterWorks, 'mobile:', isMobile);
    };

    p.draw = function () {
      p.background(240, 238, 232); // matches --bg-primary

      if (!vidEl || vidEl.readyState < 2) {
        p.fill(180); p.textAlign(p.CENTER, p.CENTER);
        p.textFont('Nunito'); p.textSize(14);
        p.text('connecting...', cW / 2, cH / 2);
        return;
      }

      const targetBlur = lookScore * blurAmount;
      currentBlur = p.lerp(currentBlur, targetBlur, 0.2);

      // Send the SMOOTHED blur ratio to partner (matches what they actually see)
      const now = Date.now();
      if (now - lastGazeSendTime > 50) {
        socket.emit('gaze-score', currentBlur / blurAmount);
        lastGazeSendTime = now;
      }

      // Partner gaze blur on local video is applied in the socket handler

      // Draw remote video with blur
      const vr = vidEl.videoWidth / vidEl.videoHeight, cr = cW / cH;
      let dw, dh, dx, dy;
      if (vr > cr) { dh = cH; dw = cH * vr; } else { dw = cW; dh = cW / vr; }
      dx = (cW - dw) / 2; dy = (cH - dh) / 2;

      const ctx = p.drawingContext, blur = Math.round(currentBlur);
      ctx.save(); ctx.translate(cW, 0); ctx.scale(-1, 1);

      if (ctxFilterWorks) {
        // Desktop: blur inside canvas pixels
        ctx.filter = blur > 0 ? `blur(${blur}px)` : 'none';
        ctx.drawImage(vidEl, dx, dy, dw, dh);
        ctx.filter = 'none';
        canvasEl.style.filter = 'none';
      } else {
        // Mobile: draw clean, apply CSS filter (contained by .video-frame)
        ctx.drawImage(vidEl, dx, dy, dw, dh);
        canvasEl.style.filter = blur > 0 ? `blur(${blur}px)` : 'none';
      }

      ctx.restore();

      if (currentBlur > 5 && ctxFilterWorks) {
        const alpha = p.map(currentBlur, 5, blurAmount, 0, 60);
        p.noStroke();
        p.fill(246, 244, 239, alpha);
        p.rect(0, 0, cW, cH);
      }
    };

    p.windowResized = function () {
      const container = document.getElementById('canvas-container');
      if (container) {
        cW = container.clientWidth;
        cH = container.clientHeight;
        p.resizeCanvas(cW, cH);
      }
    };
  });
}

// ============================================================
// UTILS
// ============================================================

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ============================================================
// 9. ECHOES (call history)
// ============================================================

socket.on('history-data', (data) => {
  renderEchoes(data.history || []);
});

function loadEchoes() {
  if (currentUser) {
    socket.emit('get-history', currentUser.uid);
  }
}

function renderEchoes(history) {
  const list = document.getElementById('echoes-list');
  const empty = document.getElementById('echoes-empty');
  if (!list) return;
  list.innerHTML = '';

  if (history.length === 0) {
    if (empty) empty.style.display = 'flex';
    return;
  }
  if (empty) empty.style.display = 'none';

  history.forEach(call => {
    const isCaller = currentUser && call.caller_uid === currentUser.uid;
    const otherName = isCaller ? call.callee_name : call.caller_name;
    const isMissed = call.was_missed === 1;

    const item = document.createElement('div');
    item.className = 'echo-item' + (isMissed ? ' echo-missed' : '');

    let detail;
    if (isMissed) {
      detail = isCaller ? 'you reached out' : `${otherName.split(' ')[0]} reached out`;
    } else if (call.duration_seconds) {
      const mins = Math.floor(call.duration_seconds / 60);
      const secs = call.duration_seconds % 60;
      detail = mins > 0 ? `talked for ${mins}m ${secs}s` : `talked for ${secs}s`;
    } else {
      detail = 'connected';
    }

    item.innerHTML = `
      <div class="echo-left">
        <span class="echo-name">${escapeHtml(otherName)}</span>
        <span class="echo-detail">${detail}</span>
      </div>
      <span class="echo-time">${formatTimeAgo(call.started_at)}</span>
    `;
    list.appendChild(item);
  });
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

// ============================================================
// 8. THE MIRROR (pre-call setup)
// ============================================================

let mirrorStream = null;
let mirrorCamOn = true;
let mirrorMicOn = true;

const mirrorVideo = document.getElementById('mirror-video');
const mirrorNoCam = document.getElementById('mirror-no-camera');
const mirrorCamSelect = document.getElementById('mirror-camera');
const mirrorMicSelect = document.getElementById('mirror-mic');
const mirrorCamToggle = document.getElementById('mirror-cam-toggle');
const mirrorMicToggle = document.getElementById('mirror-mic-toggle');
const mirrorStatusInput = document.getElementById('mirror-status');

// Start mirror camera when navigating to the mirror view
function startMirror() {
  if (mirrorStream) return; // already running
  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
      mirrorStream = stream;
      mirrorVideo.srcObject = stream;
      mirrorNoCam.classList.add('hidden');
      enumerateDevices();
    })
    .catch(err => {
      console.error('Mirror camera error:', err);
      mirrorNoCam.classList.remove('hidden');
    });
}

function stopMirror() {
  if (mirrorStream) {
    mirrorStream.getTracks().forEach(t => t.stop());
    mirrorStream = null;
  }
  if (mirrorVideo) mirrorVideo.srcObject = null;
}

async function enumerateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');

    mirrorCamSelect.innerHTML = '';
    cameras.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `camera ${i + 1}`;
      mirrorCamSelect.appendChild(opt);
    });

    mirrorMicSelect.innerHTML = '';
    mics.forEach((mic, i) => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `microphone ${i + 1}`;
      mirrorMicSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('Device enumeration error:', err);
  }
}

// Switch camera
if (mirrorCamSelect) {
  mirrorCamSelect.addEventListener('change', async () => {
    if (!mirrorStream) return;
    stopMirror();
    try {
      mirrorStream = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: mirrorCamSelect.value } },
        audio: mirrorMicSelect.value ? { deviceId: { exact: mirrorMicSelect.value } } : true
      });
      mirrorVideo.srcObject = mirrorStream;
      mirrorNoCam.classList.add('hidden');
    } catch (err) {
      console.error('Camera switch error:', err);
    }
  });
}

// Switch mic
if (mirrorMicSelect) {
  mirrorMicSelect.addEventListener('change', async () => {
    if (!mirrorStream) return;
    stopMirror();
    try {
      mirrorStream = await navigator.mediaDevices.getUserMedia({
        video: mirrorCamSelect.value ? { deviceId: { exact: mirrorCamSelect.value } } : true,
        audio: { deviceId: { exact: mirrorMicSelect.value } }
      });
      mirrorVideo.srcObject = mirrorStream;
    } catch (err) {
      console.error('Mic switch error:', err);
    }
  });
}

// Camera toggle
if (mirrorCamToggle) {
  mirrorCamToggle.addEventListener('click', () => {
    mirrorCamOn = !mirrorCamOn;
    if (mirrorStream) {
      mirrorStream.getVideoTracks().forEach(t => { t.enabled = mirrorCamOn; });
    }
    mirrorCamToggle.classList.toggle('mirror-toggle-active', mirrorCamOn);
    mirrorCamToggle.innerHTML = mirrorCamOn
      ? '<i data-lucide="video" class="toggle-icon"></i> camera on'
      : '<i data-lucide="video-off" class="toggle-icon"></i> camera off';
    mirrorNoCam.classList.toggle('hidden', mirrorCamOn);
    if (window.lucide) lucide.createIcons();
  });
}

// Mic toggle
if (mirrorMicToggle) {
  mirrorMicToggle.addEventListener('click', () => {
    mirrorMicOn = !mirrorMicOn;
    if (mirrorStream) {
      mirrorStream.getAudioTracks().forEach(t => { t.enabled = mirrorMicOn; });
    }
    mirrorMicToggle.classList.toggle('mirror-toggle-active', mirrorMicOn);
    mirrorMicToggle.innerHTML = mirrorMicOn
      ? '<i data-lucide="mic" class="toggle-icon"></i> mic on'
      : '<i data-lucide="mic-off" class="toggle-icon"></i> mic off';
    if (window.lucide) lucide.createIcons();
  });
}

// Vibe status — send to server on change
if (mirrorStatusInput) {
  let statusTimeout;
  mirrorStatusInput.addEventListener('input', () => {
    clearTimeout(statusTimeout);
    statusTimeout = setTimeout(() => {
      socket.emit('set-status', mirrorStatusInput.value.trim());
    }, 500);
  });
}

// Start/stop mirror when navigating to/from the view
const origShowView = showView;
showView = function(viewId) {
  // Stop mirror when leaving
  const currentActive = document.querySelector('.view.active');
  if (currentActive && currentActive.id === 'view-mirror') {
    stopMirror();
  }
  origShowView(viewId);
  if (viewId === 'mirror') startMirror();
  if (viewId === 'echoes') loadEchoes();
};
function escapeAttr(s) { return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;'); }
