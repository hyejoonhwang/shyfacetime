const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// Track connected users waiting for a call
const waitingUsers = new Map(); // socketId -> { name }
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

    // Tell the caller to start the WebRTC offer
    caller.emit('call-started', { partnerId: socket.id });
    socket.emit('call-started', { partnerId: callerId });

    broadcastWaitingList();
  });

  // User declines a call
  socket.on('call-decline', (callerId) => {
    const caller = io.sockets.sockets.get(callerId);
    if (caller) caller.emit('call-declined');
  });

  // WebRTC signaling: relay offer
  socket.on('webrtc-offer', (data) => {
    const partner = io.sockets.sockets.get(data.targetId);
    if (partner) partner.emit('webrtc-offer', { offer: data.offer, callerId: socket.id });
  });

  // WebRTC signaling: relay answer
  socket.on('webrtc-answer', (data) => {
    const partner = io.sockets.sockets.get(data.targetId);
    if (partner) partner.emit('webrtc-answer', { answer: data.answer });
  });

  // WebRTC signaling: relay ICE candidates
  socket.on('webrtc-ice', (data) => {
    const partner = io.sockets.sockets.get(data.targetId);
    if (partner) partner.emit('webrtc-ice', { candidate: data.candidate });
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
