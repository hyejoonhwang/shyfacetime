// ============================================================
// ShyFaceTime — client
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
let currentUser = null; // Firebase user
let myName = '';
let myPhoto_url = '';
let mySocketId = null;
let partnerId = null;
let pendingCallerId = null;
let localStream = null;
let remoteStream = null;
let peerConnection = null;
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

// Listen for auth state changes
auth.onAuthStateChanged((user) => {
  if (user) {
    currentUser = user;
    myName = user.displayName || 'Anonymous';
    myPhoto_url = user.photoURL || '';

    // Update profile display
    myNameEl.textContent = myName;
    myPhoto.src = myPhoto_url;

    // Join waiting room
    showScreen(waitingScreen);
    socket.emit('join', { name: myName, photo: myPhoto_url });
  } else {
    currentUser = null;
    myName = '';
    myPhoto_url = '';
    showScreen(loginScreen);
  }
});

// Re-join waiting room on reconnect
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

// --- Incoming call ---
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
// 3. CALL SETUP (WebRTC)
// ============================================================

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let signalingQueue = [];
let peerReady = false;

function flushSignalingQueue() {
  peerReady = true;
  console.log('Peer ready, flushing', signalingQueue.length, 'queued messages');
  while (signalingQueue.length > 0) {
    const fn = signalingQueue.shift();
    fn();
  }
}

socket.on('call-started', async (data) => {
  partnerId = data.partnerId;
  peerReady = false;
  signalingQueue = [];
  showScreen(callScreen);

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    console.error('Camera error:', err);
    alert('Could not access camera/microphone');
    return;
  }

  console.log('Local stream ready');
  const localVideo = document.getElementById('local-video');
  localVideo.srcObject = localStream;

  startFaceMesh(localStream);

  peerConnection = new RTCPeerConnection(rtcConfig);

  localStream.getTracks().forEach(track => {
    peerConnection.addTrack(track, localStream);
  });

  peerConnection.ontrack = (event) => {
    console.log('Remote track received');
    remoteStream = event.streams[0];
    startP5();
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice', { targetId: partnerId, candidate: event.candidate });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('Connection state:', peerConnection.connectionState);
  };

  flushSignalingQueue();

  if (mySocketId < partnerId) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetId: partnerId, offer: offer });
    console.log('Offer sent');
  }
});

async function handleOffer(data) {
  console.log('Handling offer');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', { targetId: data.callerId, answer: answer });
  console.log('Answer sent');
}

async function handleAnswer(data) {
  console.log('Handling answer');
  await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
}

async function handleIce(data) {
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.error('ICE error:', err);
  }
}

socket.on('webrtc-offer', (data) => {
  if (!peerReady) {
    console.log('Offer queued (peer not ready)');
    signalingQueue.push(() => handleOffer(data));
    return;
  }
  handleOffer(data);
});

socket.on('webrtc-answer', (data) => {
  if (!peerReady) {
    console.log('Answer queued (peer not ready)');
    signalingQueue.push(() => handleAnswer(data));
    return;
  }
  handleAnswer(data);
});

socket.on('webrtc-ice', (data) => {
  if (!peerReady) {
    signalingQueue.push(() => handleIce(data));
    return;
  }
  handleIce(data);
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
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
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
  trackCanvas = null;
  trackCtx = null;
  document.querySelectorAll('video[style*="display: none"], audio').forEach(el => {
    el.remove();
  });
  remoteStream = null;
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

      // Draw several frames first so canvas has data
      drawFrame();

      // Small delay to ensure canvas has real frames before model starts
      setTimeout(() => {
        faceMesh = ml5.faceMesh({
          maxFaces: 1,
          refineLandmarks: true,
          flipped: false
        }, () => {
          console.log('FaceMesh loaded, starting detection');
          faceMeshReady = true;
          startDetection();
        });
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

    // Watchdog: if no results for 3 seconds, restart detection
    clearInterval(watchdogId);
    watchdogId = setInterval(() => {
      if (!faceMeshReady) { clearInterval(watchdogId); return; }
      const elapsed = Date.now() - lastResultTime;
      if (elapsed > 3000) {
        console.log('Watchdog: no results for 3s, restarting detection');
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

    gazeDebug.textContent = `iris: ${irisScore.toFixed(2)} (L:${leftRatio.toFixed(2)} R:${rightRatio.toFixed(2)}) head: ${headScore.toFixed(2)} → look: ${lookScore.toFixed(2)}`;
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

    gazeDebug.textContent = `(no iris) head: ${headScore.toFixed(2)} vert: ${vertScore.toFixed(2)} → look: ${lookScore.toFixed(2)} [${kp.length} kp]`;
  }
}

// ============================================================
// 6. P5 CANVAS — the core experience
// ============================================================

function startP5() {
  if (p5Instance) return;

  p5Instance = new p5((p) => {
    let remoteVideo;
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

      remoteVideo = document.createElement('video');
      remoteVideo.srcObject = remoteStream;
      remoteVideo.autoplay = true;
      remoteVideo.playsInline = true;
      remoteVideo.muted = true;
      remoteVideo.style.position = 'fixed';
      remoteVideo.style.left = '-9999px';
      remoteVideo.style.top = '0';
      document.body.appendChild(remoteVideo);
      remoteVideo.play().catch(e => console.error('Video play error:', e));

      const audioEl = document.createElement('audio');
      audioEl.srcObject = remoteStream;
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEl.play().catch(e => console.error('Audio play error:', e));

      isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    };

    p.draw = function () {
      p.background(10);

      if (!remoteVideo || remoteVideo.readyState < 2) {
        p.fill(100);
        p.textAlign(p.CENTER, p.CENTER);
        p.textSize(16);
        p.text('connecting...', canvasW / 2, canvasH / 2);
        return;
      }

      const targetBlur = lookScore * blurAmount;
      currentBlur = p.lerp(currentBlur, targetBlur, 0.12);

      const videoRatio = remoteVideo.videoWidth / remoteVideo.videoHeight;
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
        // Desktop: ctx.filter (per-pixel blur)
        canvasEl.style.filter = 'none';
        ctx.filter = blurPx > 0 ? `blur(${blurPx}px)` : 'none';
        ctx.drawImage(remoteVideo, drawX, drawY, drawW, drawH);
        ctx.filter = 'none';

        if (currentBlur > 5) {
          const alpha = p.map(currentBlur, 5, blurAmount, 0, 80);
          p.noStroke();
          p.fill(10, 10, 10, alpha);
          p.rect(0, 0, canvasW, canvasH);
        }
      } else {
        // Mobile: draw video, apply CSS blur to canvas element
        ctx.drawImage(remoteVideo, drawX, drawY, drawW, drawH);
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
