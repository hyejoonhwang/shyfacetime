const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

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
const waitingUsers = new Map(); // socketId -> { name, photo }
const activeCalls = new Map();  // socketId -> partnerSocketId

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  // User joins the waiting room
  socket.on('join', (data) => {
    waitingUsers.set(socket.id, { name: data.name || 'Anonymous', photo: data.photo || '' });
    broadcastWaitingList();
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

    // Remove both from waiting room
    waitingUsers.delete(socket.id);
    waitingUsers.delete(callerId);

    // Track the active call
    activeCalls.set(socket.id, callerId);
    activeCalls.set(callerId, socket.id);

    // Generate a unique room name for p5LiveMedia
    const roomName = 'shy-' + crypto.randomBytes(8).toString('hex');

    // Send room name to both users
    caller.emit('call-started', { partnerId: socket.id, room: roomName });
    socket.emit('call-started', { partnerId: callerId, room: roomName });

    broadcastWaitingList();
  });

  // User declines a call
  socket.on('call-decline', (callerId) => {
    const caller = io.sockets.sockets.get(callerId);
    if (caller) caller.emit('call-declined');
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
    activeCalls.delete(partnerId);
  }
  activeCalls.delete(socket.id);
}

function broadcastWaitingList() {
  const list = [];
  for (const [id, info] of waitingUsers) {
    list.push({ id, name: info.name, photo: info.photo });
  }
  io.emit('waiting-list', list);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ShyFaceTime running on http://localhost:${PORT}`);
});
