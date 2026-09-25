const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// মেমোরিতে ডাটা (সার্ভার বন্ধ হলে মুছে যাবে, কিন্তু টেস্টের জন্য যথেষ্ট)
const users = {};      // uid -> {uid, name, avatar, coins}
const friendships = {}; // uid -> [friendUids]
const requests = {};    // uid -> [pendingUids]
const messages = {};    // "uid1__uid2" -> [{from, text, ts}]
const rooms = {};       // roomId -> room object
const onlineUsers = new Map();

function genUID() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
  return 'LK-' + s;
}
function genRoomId() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return 'R-' + s;
}

// ---------- LOGIN ----------
app.post('/api/login', (req, res) => {
  const { deviceId, name, avatar } = req.body;
  if (!deviceId) return res.status(400).json({ error: 'no deviceId' });

  let user = users[deviceId];
  if (!user) {
    const uid = genUID();
    user = {
      uid,
      deviceId,
      name: name || ('Guest' + Math.floor(1000 + Math.random() * 9000)),
      avatar: avatar || '👨‍💼',
      coins: 2500
    };
    users[deviceId] = user;
    friendships[uid] = [];
    requests[uid] = [];
  }
  res.json({ user });
});

// ---------- UPDATE PROFILE ----------
app.post('/api/update', (req, res) => {
  const { deviceId, name, avatar } = req.body;
  const user = users[deviceId];
  if (!user) return res.status(404).json({ error: 'not found' });
  if (name) user.name = name;
  if (avatar) user.avatar = avatar;
  res.json({ user });
});

// ---------- SEARCH USER ----------
app.get('/api/search/:uid', (req, res) => {
  const q = req.params.uid.toUpperCase();
  const found = Object.values(users).find(u => u.uid === q);
  if (!found) return res.status(404).json({ error: 'not found' });
  res.json({
    uid: found.uid,
    name: found.name,
    avatar: found.avatar
  });
});

// ---------- FRIEND LIST ----------
app.get('/api/friends/:uid', (req, res) => {
  const uid = req.params.uid;
  const friendUids = friendships[uid] || [];
  const pending = requests[uid] || [];
  const list = friendUids.map(fuid => {
    const u = Object.values(users).find(x => x.uid === fuid);
    return u ? { uid: u.uid, name: u.name, avatar: u.avatar } : null;
  }).filter(Boolean);
  const reqList = pending.map(fuid => {
    const u = Object.values(users).find(x => x.uid === fuid);
    return u ? { uid: u.uid, name: u.name, avatar: u.avatar } : null;
  }).filter(Boolean);
  res.json({ friends: list, requests: reqList });
});

// ---------- MESSAGES ----------
app.get('/api/messages/:uid/:otherUid', (req, res) => {
  const { uid, otherUid } = req.params;
  const key = [uid, otherUid].sort().join('__');
  res.json(messages[key] || []);
});

// ---------- SOCKET ----------
io.on('connection', (socket) => {
  let myUid = null;

  socket.on('register', ({ uid }) => {
    myUid = uid;
    socket.join(`user:${uid}`);
    onlineUsers.set(uid, socket.id);
    console.log('🟢 online:', uid);
  });

  // চ্যাট
  socket.on('chat:send', ({ toUid, text }) => {
    if (!myUid) return;
    const key = [myUid, toUid].sort().join('__');
    if (!messages[key]) messages[key] = [];
    const msg = { from: myUid, text, ts: Date.now() };
    messages[key].push(msg);
    io.to(`user:${toUid}`).emit('chat:message', msg);
    socket.emit('chat:sent', msg);
  });

  // ফ্রেন্ড রিকোয়েস্ট
  socket.on('friend:request', ({ toUid }) => {
    if (!myUid) return;
    if (!requests[toUid]) requests[toUid] = [];
    if (!requests[toUid].includes(myUid)) requests[toUid].push(myUid);
    io.to(`user:${toUid}`).emit('friend:new-request', { from: myUid });
  });

  socket.on('friend:accept', ({ fromUid }) => {
    if (!myUid) return;
    if (!friendships[myUid]) friendships[myUid] = [];
    if (!friendships[fromUid]) friendships[fromUid] = [];
    if (!friendships[myUid].includes(fromUid)) friendships[myUid].push(fromUid);
    if (!friendships[fromUid].includes(myUid)) friendships[fromUid].push(myUid);
    requests[myUid] = (requests[myUid] || []).filter(x => x !== fromUid);
    io.to(`user:${fromUid}`).emit('friend:accepted', { by: myUid });
  });

  // রুম
  socket.on('room:create', ({ mode, betAmount, user }, cb) => {
    const roomId = genRoomId();
    const maxPlayers = mode === '1v1' ? 2 : 4;
    const room = {
      roomId,
      mode,
      betAmount,
      maxPlayers,
      players: [{ uid: user.uid, name: user.name, avatar: user.avatar }],
      status: 'waiting',
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000
    };
    rooms[roomId] = room;
    socket.join(roomId);
    socket.roomId = roomId;
    io.emit('room:list', Object.values(rooms).filter(r => r.status === 'waiting'));
    if (cb) cb({ ok: true, room });
  });

  socket.on('room:list', (cb) => {
    const list = Object.values(rooms).filter(r => r.status === 'waiting');
    if (cb) cb(list);
    else socket.emit('room:list', list);
  });

  socket.on('room:join', ({ roomId, user }, cb) => {
    const room = rooms[roomId];
    if (!room) return cb && cb({ ok: false, error: 'রুম নেই' });
    if (room.players.length >= room.maxPlayers) return cb && cb({ ok: false, error: 'রুম পূর্ণ' });
    if (room.players.find(p => p.uid === user.uid)) return cb && cb({ ok: false, error: 'আপনি আছেন' });

    room.players.push({ uid: user.uid, name: user.name, avatar: user.avatar });
    socket.join(roomId);
    socket.roomId = roomId;

    io.to(roomId).emit('room:update', room);
    if (room.players.length === room.maxPlayers) {
      room.status = 'playing';
      io.to(roomId).emit('room:start', room);
    }
    io.emit('room:list', Object.values(rooms).filter(r => r.status === 'waiting'));
    if (cb) cb({ ok: true, room });
  });

  socket.on('room:cancel', ({ roomId }) => {
    if (rooms[roomId]) {
      rooms[roomId].status = 'cancelled';
      io.to(roomId).emit('room:cancelled', { roomId });
      delete rooms[roomId];
      io.emit('room:list', Object.values(rooms).filter(r => r.status === 'waiting'));
    }
  });

  // গেম অ্যাকশন
  socket.on('game:action', ({ roomId, action }) => {
    socket.to(roomId).emit('game:action', { from: myUid, action });
  });

  socket.on('game:state', ({ roomId, state }) => {
    socket.to(roomId).emit('game:state', state);
  });

  socket.on('disconnect', () => {
    if (myUid) onlineUsers.delete(myUid);
    if (socket.roomId && rooms[socket.roomId]) {
      const r = rooms[socket.roomId];
      r.status = 'cancelled';
      io.to(socket.roomId).emit('room:cancelled', { roomId: socket.roomId });
      delete rooms[socket.roomId];
      io.emit('room:list', Object.values(rooms).filter(r => r.status === 'waiting'));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('🚀 Server running on port ' + PORT));