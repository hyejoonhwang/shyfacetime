// ============================================================
// ShyFaceTime — client (p5LiveMedia version)
// ============================================================

// --- Firebase Auth ---
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
const callScreen = document.getElementById('call-screen');
const googleSigninBtn = document.getElementById('google-signin-btn');
const signoutBtn = document.getElementById('signout-btn');
const myPhoto = document.getElementById('my-photo');
const myNameEl = document.getElementById('my-name');
const userList = document.getElementById('user-list');
const incomingCallModal = document.getElementById('incoming-call');
const callerNameEl = document.getElementById('caller-name');
const callerPhotoEl = document.getElementById('caller-photo');
const acceptBtn = document.getElementById('accept-btn');
const declineBtn = document.getElementById('decline-btn');
const hangupBtn = document.getElementById('hangup-btn');
const gazeDebug = document.getElementById('gaze-debug');

// --- State ---
let currentUser = null;
let myName = '';
let myPhoto_url = '';
let mySocketId = null;
let partnerId = null;
let pendingCallerId = null;
let localStream = null;
let p5lm = null;        // p5LiveMedia instance
let remoteVideo = null;  // remote video element from p5LiveMedia
let p5Instance = null;
let faceMesh = null;
let lookScore = 1;

// --- Helpers ---
function showScreen(screen) {
  [loginScreen, waitingScreen, callScreen].forEach(s => s.classList.remove('active'));
  screen.classList.add('active');
}

// ============================================================
// 1. FIREBASE AUTH
// ============================================================

googleSigninBtn.addEventListener('click', () => {
  auth.signInWithPopup(googleProvider).catch(err => {
    console.error('Sign-in error:', err);
  });
});

signoutBtn.addEventListener('click', () => {
  auth.signOut();
});

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
  userList.innerHTML = '';
  list.forEach((user) => {
    const isSelf = user.id === mySocketId;
    const card = document.createElement('div');
    card.className = 'user-card' + (isSelf ? ' self' : '');
    card.innerHTML = `
      <div class="user-info">
        <img class="user-photo" src="${escapeAttr(user.photo)}" alt="">
        <span class="name">${escapeHtml(user.name)}${isSelf ? ' (you)' : ''}</span>
      </div>
      ${isSelf ? '' : `<button onclick="requestCall('${user.id}')">call</button>`}
    `;
    userList.appendChild(card);
  });
});

window.requestCall = function (targetId) {
  socket.emit('call-request', targetId);
};

socket.on('incoming-call', (data) => {
  pendingCallerId = data.callerId;
  callerNameEl.textContent = data.callerName;
  callerPhotoEl.src = data.callerPhoto || '';
  incomingCallModal.classList.remove('hidden');
});

acceptBtn.addEventListener('click', () => {
  incomingCallModal.classList.add('hidden');
  socket.emit('call-accept', pendingCallerId);
});

declineBtn.addEventListener('click', () => {
  incomingCallModal.classList.add('hidden');
  socket.emit('call-decline', pendingCallerId);
  pendingCallerId = null;
});

socket.on('call-declined', () => {});

// ============================================================
// 3. CALL SETUP (p5LiveMedia)
// ============================================================

socket.on('call-started', async (data) => {
  partnerId = data.partnerId;
  const roomName = data.room;
  console.log('Call started, joining room:', roomName);
  showScreen(callScreen);

  // Get local webcam
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not access camera/microphone');
    return;
  }

  // Show local video preview
  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;

  // Start face tracking
  startFaceMesh(localStream);

  // p5LiveMedia needs a sketch-like object with createVideo()
  const sketchShim = {
    createVideo: function(stream) {
      console.log('sketchShim.createVideo called with stream:', stream);
      const video = document.createElement('video');
      video.srcObject = stream;
      video.autoplay = true;
      video.playsInline = true;
      video.style.position = 'fixed';
      video.style.left = '-9999px';
      document.body.appendChild(video);
      video.play().catch(e => console.error('Remote video play:', e));
      return { elt: video };
    }
  };

  console.log('Creating p5LiveMedia for room:', roomName);
  p5lm = new p5LiveMedia(sketchShim, "CAPTURE", localStream, roomName);

  p5lm.on('stream', (stream, id) => {
    console.log('p5LiveMedia stream event! id:', id, 'stream:', stream);
    const videoEl = stream.elt || stream;
    remoteVideo = videoEl;
    startP5(videoEl);
  });

  p5lm.on('disconnect', (id) => {
    console.log('p5LiveMedia: peer disconnected', id);
  });

  p5lm.on('connect', (id) => {
    console.log('p5LiveMedia: connected to signaling server, my id:', id);
  });
});

// ============================================================
// 4. HANG UP
// ============================================================

hangupBtn.addEventListener('click', hangUp);

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
  if (p5lm) {
    p5lm.disconnect(-1);
    p5lm = null;
  }
  if (p5Instance) {
    p5Instance.remove();
    p5Instance = null;
  }
  faceMeshReady = false;
  if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
  if (faceMesh) {
    faceMesh.detectStop();
    faceMesh = null;
  }
  if (frameLoopId) {
    cancelAnimationFrame(frameLoopId);
    frameLoopId = null;
  }
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  trackCanvas = null;
  trackCtx = null;
  // Clean up off-screen video/audio elements
  document.querySelectorAll('video[style*="-9999"], audio').forEach(el => {
    if (el.id !== 'local-video') el.remove();
  });
  remoteVideo = null;
  partnerId = null;
  lookScore = 1;
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

function startFaceMesh(stream) {
  gazeDebug.textContent = 'setting up...';
  console.log('startFaceMesh called');
  noFaceCount = 0;
  lastResultTime = 0;

  trackCanvas = document.createElement('canvas');
  trackCanvas.width = 320;
  trackCanvas.height = 240;
  trackCtx = trackCanvas.getContext('2d', { willReadFrequently: true });

  const localVid = document.getElementById('local-video');

  function drawFrame() {
    if (!trackCanvas) return;
    if (localVid.readyState >= 2) {
      trackCtx.drawImage(localVid, 0, 0, 320, 240);
    }
    frameLoopId = requestAnimationFrame(drawFrame);
  }

  function waitForVideo() {
    if (localVid.readyState >= 2 && localVid.videoWidth > 0) {
      console.log('Local video ready:', localVid.videoWidth, 'x', localVid.videoHeight);
      gazeDebug.textContent = 'video ready, loading model...';
      drawFrame();

      setTimeout(() => {
        console.log('Creating faceMesh...');
        faceMesh = ml5.faceMesh({
          maxFaces: 1,
          refineLandmarks: true,
          flipped: false
        });

        // Poll for model readiness instead of relying on callback
        // (p5's preload system can interfere with the callback)
        function checkModelReady() {
          if (faceMesh && typeof faceMesh.detectStart === 'function') {
            console.log('FaceMesh ready, has detectStart');
            faceMeshReady = true;
            startDetection();
          } else {
            console.log('FaceMesh not ready yet, checking...');
            gazeDebug.textContent = 'loading model...';
            setTimeout(checkModelReady, 500);
          }
        }
        checkModelReady();
      }, 500);
    } else {
      gazeDebug.textContent = `waiting for video... rs=${localVid.readyState}`;
      setTimeout(waitForVideo, 300);
    }
  }

  function startDetection() {
    if (!faceMesh || !faceMeshReady) return;
    lastResultTime = Date.now();
    gazeDebug.textContent = 'detecting...';
    console.log('Starting detectStart');
    faceMesh.detectStart(trackCanvas, onFaceResults);

    clearInterval(watchdogId);
    watchdogId = setInterval(() => {
      if (!faceMeshReady) { clearInterval(watchdogId); return; }
      const elapsed = Date.now() - lastResultTime;
      if (elapsed > 3000) {
        console.log('Watchdog: restarting detection');
        gazeDebug.textContent = 'restarting detection...';
        faceMesh.detectStop();
        setTimeout(() => {
          lastResultTime = Date.now();
          faceMesh.detectStart(trackCanvas, onFaceResults);
          console.log('Detection restarted');
        }, 500);
      }
    }, 2000);
  }

  waitForVideo();
}

function onFaceResults(results) {
  lastResultTime = Date.now();

  if (!results || results.length === 0) {
    noFaceCount++;
    lookScore = 0;
    gazeDebug.textContent = `no face (${noFaceCount})`;
    return;
  }
  noFaceCount = 0;

  const kp = results[0].keypoints;
  const hasIris = kp.length > 468;

  if (hasIris) {
    const leftOuter = kp[33];
    const leftInner = kp[133];
    const leftIris = kp[468];
    const rightInner = kp[362];
    const rightOuter = kp[263];
    const rightIris = kp[473];

    const leftEyeW = Math.abs(leftInner.x - leftOuter.x);
    const rightEyeW = Math.abs(rightOuter.x - rightInner.x);

    let leftRatio = 0.5;
    let rightRatio = 0.5;

    if (leftEyeW > 1) {
      const minX = Math.min(leftOuter.x, leftInner.x);
      leftRatio = (leftIris.x - minX) / leftEyeW;
    }
    if (rightEyeW > 1) {
      const minX = Math.min(rightOuter.x, rightInner.x);
      rightRatio = (rightIris.x - minX) / rightEyeW;
    }

    const irisDeviation = (Math.abs(leftRatio - 0.5) + Math.abs(rightRatio - 0.5)) / 2;
    const irisScore = 1 - Math.min(irisDeviation * 5, 1);

    const noseTip = kp[1];
    const leftCheek = kp[234];
    const rightCheek = kp[454];
    const faceWidth = Math.abs(rightCheek.x - leftCheek.x);
    const faceCenter = (leftCheek.x + rightCheek.x) / 2;

    let headScore = 1;
    if (faceWidth > 1) {
      const headDeviation = Math.abs(noseTip.x - faceCenter) / faceWidth;
      headScore = 1 - Math.min(headDeviation * 4, 1);
    }

    lookScore = irisScore * 0.6 + headScore * 0.4;

    gazeDebug.textContent = `iris: ${irisScore.toFixed(2)} head: ${headScore.toFixed(2)} → look: ${lookScore.toFixed(2)}`;
  } else {
    const noseTip = kp[1];
    const leftCheek = kp[234];
    const rightCheek = kp[454];
    const faceWidth = Math.abs(rightCheek.x - leftCheek.x);
    const faceCenter = (leftCheek.x + rightCheek.x) / 2;

    let headScore = 1;
    if (faceWidth > 1) {
      const headDeviation = Math.abs(noseTip.x - faceCenter) / faceWidth;
      headScore = 1 - Math.min(headDeviation * 3, 1);
    }

    const foreHead = kp[10];
    const chin = kp[152];
    const faceHeight = Math.abs(chin.y - foreHead.y);
    const noseVertical = (noseTip.y - foreHead.y) / faceHeight;
    const vertDeviation = Math.abs(noseVertical - 0.65);
    const vertScore = 1 - Math.min(vertDeviation * 3, 1);

    lookScore = headScore * 0.7 + vertScore * 0.3;

    gazeDebug.textContent = `(no iris) head: ${headScore.toFixed(2)} vert: ${vertScore.toFixed(2)} → look: ${lookScore.toFixed(2)}`;
  }
}

// ============================================================
// 6. P5 CANVAS — the core experience
// ============================================================

function startP5(remoteVideoEl) {
  if (p5Instance) return;

  p5Instance = new p5((p) => {
    let vidEl; // the HTML video element for the remote stream
    let blurAmount = 40;
    let currentBlur = 40;
    let canvasW, canvasH;
    let canvasEl;
    let isMobile = false;

    p.setup = function () {
      canvasW = window.innerWidth;
      canvasH = window.innerHeight;
      const canvas = p.createCanvas(canvasW, canvasH);
      canvas.parent('canvas-container');
      canvasEl = canvas.elt;

      // remoteVideoEl comes from p5LiveMedia — could be HTMLVideoElement or p5.MediaElement
      vidEl = remoteVideoEl;

      // Ensure it's playing
      if (vidEl.play) {
        vidEl.autoplay = true;
        vidEl.playsInline = true;
        vidEl.play().catch(e => console.error('Remote video play error:', e));
      }

      // Separate audio element for remote audio
      const audioEl = document.createElement('audio');
      audioEl.srcObject = vidEl.srcObject || vidEl.captureStream?.();
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEl.play().catch(e => console.error('Audio play error:', e));

      isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    };

    p.draw = function () {
      p.background(10);

      if (!vidEl || vidEl.readyState < 2) {
        p.fill(100);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(16);
        p.text('connecting...', canvasW / 2, canvasH / 2);
        return;
      }

      const targetBlur = lookScore * blurAmount;
      currentBlur = p.lerp(currentBlur, targetBlur, 0.12);

      const videoRatio = vidEl.videoWidth / vidEl.videoHeight;
      const canvasRatio = canvasW / canvasH;
      let drawW, drawH, drawX, drawY;
      if (videoRatio > canvasRatio) {
        drawH = canvasH; drawW = canvasH * videoRatio;
      } else {
        drawW = canvasW; drawH = canvasW / videoRatio;
      }
      drawX = (canvasW - drawW) / 2;
      drawY = (canvasH - drawH) / 2;

      const ctx = p.drawingContext;
      const blurPx = Math.round(currentBlur);

      if (!isMobile) {
        canvasEl.style.filter = 'none';
        ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
        ctx.drawImage(vidEl, drawX, drawY, drawW, drawH);
        ctx.filter = 'none';

        if (currentBlur > 5) {
          const alpha = p.map(currentBlur, 5, blurAmount, 0, 80);
          p.noStroke();
          p.fill(10, 10, 10, alpha);
          p.rect(0, 0, canvasW, canvasH);
        }
      } else {
        ctx.drawImage(vidEl, drawX, drawY, drawW, drawH);
        if (blurPx > 0) {
          canvasEl.style.filter = `blur(${blurPx}px) brightness(${p.map(currentBlur, 0, blurAmount, 1, 0.6)})`;
        } else {
          canvasEl.style.filter = 'none';
        }
      }
    };

    p.windowResized = function () {
      canvasW = window.innerWidth;
      canvasH = window.innerHeight;
      p.resizeCanvas(canvasW, canvasH);
    };
  });
}

// ============================================================
// UTILS
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}
