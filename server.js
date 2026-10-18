const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

io.on('connection', (socket) => {
  socket.on('join-room', (room, name) => {
    socket.join(room);
    socket.data.room = room;
    socket.data.name = name;

    const others = [...(io.sockets.adapter.rooms.get(room) || [])]
      .filter((id) => id !== socket.id)
      .map((id) => ({ id, name: io.sockets.sockets.get(id)?.data.name }));
    socket.emit('existing-users', others);

    socket.to(room).emit('user-joined', { id: socket.id, name });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (socket.data.room) {
      socket.to(socket.data.room).emit('user-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
