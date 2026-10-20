const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'Public')));

io.on('connection', (socket) => {
  socket.on('join-room', (room, name) => {
    if (typeof room !== 'string' || typeof name !== 'string') return;
    room = room.trim().slice(0, 80);
    name = name.trim().slice(0, 40);
    if (!room || !name) return;

    const existing = [...(io.sockets.adapter.rooms.get(room) || [])]
      .map((id) => ({ id, name: io.sockets.sockets.get(id)?.data.displayName || 'Amigo' }));
    socket.data.room = room;
    socket.data.displayName = name;
    socket.join(room);
    socket.emit('existing-users', existing);
    socket.emit('music-state', rooms.get(room)?.music || null);
    socket.to(room).emit('user-joined', { id: socket.id, name });
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (typeof to === 'string' && socket.data.room && io.sockets.sockets.get(to)?.data.room === socket.data.room) {
      io.to(to).emit('signal', { from: socket.id, data });
    }
  });

  socket.on('music-play', (music) => {
    const room = socket.data.room;
    if (!room || !music || typeof music.url !== 'string' || typeof music.title !== 'string') return;
    let url;
    try { url = new URL(music.url); } catch { return; }
    if (!['https:', 'http:'].includes(url.protocol)) return;
    const state = { url: url.href, title: music.title.slice(0, 160), artist: String(music.artist || '').slice(0, 100), startedAt: Date.now(), ownerId: socket.id };
    rooms.set(room, { ...(rooms.get(room) || {}), music: state });
    io.to(room).emit('music-play', state);
  });

  socket.on('music-stop', () => {
    const room = socket.data.room;
    if (!room) return;
    rooms.set(room, { ...(rooms.get(room) || {}), music: null });
    io.to(room).emit('music-stop');
  });

  socket.on('disconnect', () => {
    const room = socket.data.room;
    if (room) {
      const music = rooms.get(room)?.music;
      if (music?.ownerId === socket.id) {
        rooms.set(room, { ...(rooms.get(room) || {}), music: null });
        socket.to(room).emit('music-stop');
      }
      socket.to(room).emit('user-left', socket.id);
      if ((io.sockets.adapter.rooms.get(room)?.size || 0) === 0) rooms.delete(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
