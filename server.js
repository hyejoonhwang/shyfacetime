const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// No caching for development
app.use(express.static('public', {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
}));

// Track connected users
const waitingUsers = new Map(); // socketId -> { name, photo, status, joinedAt, uid }
const activeCalls = new Map();  // socketId -> partnerSocketId
const activeCallIds = new Map(); // socketId -> database call row ID

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // User joins the waiting room
  socket.on('join', (data) => {
    waitingUsers.set(socket.id, {
      name: data.name || 'Anonymous',
      photo: data.photo || '',
      uid: data.uid || socket.id,
      status: '',
      joinedAt: Date.now()
    });
    broadcastWaitingList();
  });

  // User updates their vibe status
  socket.on('set-status', (status) => {
    const user = waitingUsers.get(socket.id);
    if (user) {
      user.status = (status || '').slice(0, 50);
      broadcastWaitingList();
    }
  });

  // User requests a call with another user
  socket.on('call-request', (targetId) => {
    const target = io.sockets.sockets.get(targetId);
    if (target && waitingUsers.has(targetId)) {
      const callerInfo = waitingUsers.get(socket.id);
      target.emit('incoming-call', {
        callerId: socket.id,
        callerName: callerInfo ? callerInfo.name : 'Anonymous',
        callerPhoto: callerInfo ? callerInfo.photo : ''
      });
    }
  });

  // User accepts a call
  socket.on('call-accept', (callerId) => {
    const caller = io.sockets.sockets.get(callerId);
    if (!caller) return;

    // Get user info before removing from waiting room
    const callerInfo = waitingUsers.get(callerId) || { name: 'Unknown', uid: callerId };
    const calleeInfo = waitingUsers.get(socket.id) || { name: 'Unknown', uid: socket.id };

    // Remove both from waiting room
    waitingUsers.delete(socket.id);
    waitingUsers.delete(callerId);

    // Track the active call
    activeCalls.set(socket.id, callerId);
    activeCalls.set(callerId, socket.id);

    // Record call in database
    try {
      const callId = db.recordCallStart(callerInfo.uid, callerInfo.name, calleeInfo.uid, calleeInfo.name);
      activeCallIds.set(socket.id, callId);
      activeCallIds.set(callerId, callId);
    } catch (e) { console.error('DB call start error:', e.message); }

    // Generate a unique room name for p5LiveMedia
    const roomName = 'shy-' + crypto.randomBytes(8).toString('hex');

    caller.emit('call-started', { partnerId: socket.id, room: roomName });
    socket.emit('call-started', { partnerId: callerId, room: roomName });

    broadcastWaitingList();
  });

  // User declines a call
  socket.on('call-decline', (callerId) => {
    const caller = io.sockets.sockets.get(callerId);
    if (caller) caller.emit('call-declined');
    // Record as missed call
    try {
      const callerInfo = waitingUsers.get(callerId) || { uid: callerId, name: 'Unknown' };
      const calleeInfo = waitingUsers.get(socket.id) || { uid: socket.id, name: 'Unknown' };
      db.recordMissedCall(callerInfo.uid, callerInfo.name, calleeInfo.uid, calleeInfo.name);
    } catch (e) { console.error('DB missed call error:', e.message); }
  });

  // ---- p5LiveMedia signaling protocol ----
  // p5LiveMedia uses these events for WebRTC peer connection setup
  const p5lmRooms = {};

  socket.on('room_connect', (room) => {
    socket.p5lmRoom = room;
    if (!io.p5lmRooms) io.p5lmRooms = {};
    if (!io.p5lmRooms[room]) io.p5lmRooms[room] = [];
    io.p5lmRooms[room].push(socket);

    // Send list of existing peers in the room
    const ids = io.p5lmRooms[room].map(s => s.id);
    console.log('p5lm room_connect:', room, 'peers:', ids);
    socket.emit('listresults', ids);
  });

  socket.on('signal', (to, from, data) => {
    console.log('p5lm signal:', from, '->', to);
    const room = socket.p5lmRoom;
    if (room && io.p5lmRooms && io.p5lmRooms[room]) {
      const target = io.p5lmRooms[room].find(s => s.id === to);
      if (target) {
        console.log('p5lm signal relayed to', to);
        target.emit('signal', to, from, data);
      } else {
        console.log('p5lm signal target NOT FOUND:', to, 'room has:', io.p5lmRooms[room].map(s => s.id));
      }
    } else {
      console.log('p5lm signal: no room for socket', socket.id, 'room:', room);
    }
  });

  // Relay gaze score to call partner
  socket.on('gaze-score', (score) => {
    const partnerId = activeCalls.get(socket.id);
    if (partnerId) {
      const partner = io.sockets.sockets.get(partnerId);
      if (partner) partner.emit('partner-gaze-score', score);
    }
  });

  // Fetch call history
  socket.on('get-history', (uid) => {
    try {
      const history = db.getHistory(uid);
      const connections = db.getConnections(uid);
      socket.emit('history-data', { history, connections });
    } catch (e) { console.error('DB history error:', e.message); }
  });

  // User hangs up
  socket.on('hang-up', () => {
    handleHangUp(socket);
  });

  // User disconnects
  socket.on('disconnect', () => {
    handleHangUp(socket);
    waitingUsers.delete(socket.id);
    broadcastWaitingList();

    // Clean up p5LiveMedia room
    const room = socket.p5lmRoom;
    if (room && io.p5lmRooms && io.p5lmRooms[room]) {
      io.p5lmRooms[room] = io.p5lmRooms[room].filter(s => s.id !== socket.id);
      // Notify remaining peers
      io.p5lmRooms[room].forEach(s => {
        s.emit('peer_disconnect', socket.id);
      });
      if (io.p5lmRooms[room].length === 0) {
        delete io.p5lmRooms[room];
      }
    }

    console.log('Disconnected:', socket.id);
  });
});

function handleHangUp(socket) {
  const partnerId = activeCalls.get(socket.id);
  if (partnerId) {
    const partner = io.sockets.sockets.get(partnerId);
    if (partner) partner.emit('partner-hung-up');

    // Record call end in database
    const callId = activeCallIds.get(socket.id);
    if (callId) {
      try {
        db.recordCallEnd(callId);
        // Record connection between users
        const callerInfo = waitingUsers.get(socket.id) || { uid: socket.id };
        const partnerInfo = waitingUsers.get(partnerId) || { uid: partnerId };
        db.recordConnection(callerInfo.uid || socket.id, partnerInfo.uid || partnerId);
      } catch (e) { console.error('DB call end error:', e.message); }
    }
    activeCallIds.delete(partnerId);
    activeCallIds.delete(socket.id);
    activeCalls.delete(partnerId);
  }
  activeCalls.delete(socket.id);
}

function broadcastWaitingList() {
  const list = [];
  for (const [id, info] of waitingUsers) {
    list.push({ id, name: info.name, photo: info.photo, status: info.status || '', joinedAt: info.joinedAt });
  }
  io.emit('waiting-list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ShyFaceTime running on http://localhost:${PORT}`);
});
