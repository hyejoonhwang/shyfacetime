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

  // User hangs up
  socket.on('hang-up', () => {
    handleHangUp(socket);
  });

  // User disconnects
  socket.on('disconnect', () => {
    handleHangUp(socket);
    waitingUsers.delete(socket.id);
    broadcastWaitingList();
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
