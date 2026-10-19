const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingInterval: 10000,
  pingTimeout: 20000,
});

const MAX_PESSOAS = 10;
const MAX_CHARS_CHAT = 500;
const DIAS_SESSAO = 30;
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 60 * 1000;
const ARQUIVO_CONTAS = path.join(__dirname, 'contas.json');

app.use(express.static('public'));

// ===== Contas =====

let contas = {};
try {
  contas = JSON.parse(fs.readFileSync(ARQUIVO_CONTAS, 'utf8'));
} catch (e) {
  contas = {};
}

const sessoes = new Map();     // token -> { chave, expira }
const tentativas = new Map();  // chave -> { falhas, bloqueadoAte }

// Limpa sessões vencidas de tempos em tempos
setInterval(() => {
  const agora = Date.now();
  for (const [token, s] of sessoes) {
    if (s.expira < agora) sessoes.delete(token);
  }
}, 60 * 60 * 1000);

function temConta(chave) {
  return Object.prototype.hasOwnProperty.call(contas, chave);
}

function salvarContas() {
  try {
    fs.writeFileSync(ARQUIVO_CONTAS, JSON.stringify(contas, null, 2));
  } catch (e) {
    console.error('Não foi possível salvar as contas:', e);
  }
}

// Remove acentos e põe em maiúsculas: "JOÃO" e "JOAO" viram o mesmo nome
function chaveDe(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
}

function usuarioValido(nome) {
  return /^[\p{L}\p{N}_]{3,20}$/u.test(nome);
}

function senhaValida(senha) {
  return senha.length >= 8
    && senha.length <= 100
    && /\p{Lu}/u.test(senha)
    && /\p{Nd}/u.test(senha);
}

function gerarHash(senha, salt) {
  return crypto.scryptSync(senha, salt, 64).toString('hex');
}

function senhaCorreta(conta, senha) {
  const esperado = Buffer.from(conta.hash, 'hex');
  const recebido = Buffer.from(gerarHash(senha, conta.salt), 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

function criarSessao(chave) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { chave, expira: Date.now() + DIAS_SESSAO * 24 * 60 * 60 * 1000 });
  return token;
}

function ligarUsuario(socket, chave) {
  socket.data.chave = chave;
  socket.data.nome = contas[chave].nome;
}

io.on('connection', (socket) => {
  const resposta = (responder) => (typeof responder === 'function' ? responder : () => {});

  // ===== Criar conta =====
  socket.on('cadastrar', (dados, responder) => {
    const reply = resposta(responder);
    const nome = String(dados?.usuario || '').trim().toUpperCase();
    const senha = String(dados?.senha || '');

    if (!usuarioValido(nome)) return reply({ ok: false, motivo: 'nome' });
    if (!senhaValida(senha)) return reply({ ok: false, motivo: 'senha' });

    const chave = chaveDe(nome);
    if (temConta(chave)) return reply({ ok: false, motivo: 'existe' });

    const salt = crypto.randomBytes(16).toString('hex');
    contas[chave] = { nome, salt, hash: gerarHash(senha, salt), criadoEm: Date.now() };
    salvarContas();

    ligarUsuario(socket, chave);
    reply({ ok: true, nome, token: criarSessao(chave) });
  });

  // ===== Entrar na conta =====
  socket.on('entrar', (dados, responder) => {
    const reply = resposta(responder);
    const nome = String(dados?.usuario || '').trim().toUpperCase();
    const senha = String(dados?.senha || '').slice(0, 100);
    const chave = chaveDe(nome);

    const t = tentativas.get(chave) || { falhas: 0, bloqueadoAte: 0 };
    if (t.bloqueadoAte > Date.now()) return reply({ ok: false, motivo: 'bloqueado' });

    if (!temConta(chave) || !senhaCorreta(contas[chave], senha)) {
      t.falhas += 1;
      if (t.falhas >= MAX_TENTATIVAS) {
        t.bloqueadoAte = Date.now() + BLOQUEIO_MS;
        t.falhas = 0;
      }
      tentativas.set(chave, t);
      return reply({ ok: false, motivo: 'dados' });
    }

    tentativas.delete(chave);
    ligarUsuario(socket, chave);
    reply({ ok: true, nome: contas[chave].nome, token: criarSessao(chave) });
  });

  // ===== Reconectar com a sessão salva no navegador =====
  socket.on('retomar', (token, responder) => {
    const reply = resposta(responder);
    const s = sessoes.get(String(token || ''));
    if (!s || s.expira < Date.now() || !temConta(s.chave)) return reply({ ok: false });

    ligarUsuario(socket, s.chave);
    reply({ ok: true, nome: socket.data.nome });
  });

  // ===== Sair da conta =====
  socket.on('sair-conta', (token, responder) => {
    const reply = resposta(responder);
    if (socket.data.room) return reply({ ok: false, motivo: 'em_sala' });

    sessoes.delete(String(token || ''));
    socket.data.chave = null;
    socket.data.nome = null;
    reply({ ok: true });
  });

  // ===== Entrar na sala =====
  socket.on('join-room', (room, responder) => {
    const reply = resposta(responder);
    if (!socket.data.chave) return reply({ ok: false, motivo: 'login' });
    if (socket.data.room) return reply({ ok: true });

    const nomeSala = String(room || '').trim().toUpperCase().slice(0, 40);
    if (!nomeSala) return reply({ ok: false, motivo: 'dados' });

    const chave = 'sala:' + nomeSala;
    const sala = io.sockets.adapter.rooms.get(chave);

    // Se a mesma conta já estiver na sala (por exemplo, uma conexão antiga que ainda não caiu),
    // a conexão antiga é encerrada e a nova assume
    const substituidos = [];
    if (sala) {
      for (const id of sala) {
        const outro = io.sockets.sockets.get(id);
        if (outro && outro.data.chave === socket.data.chave) substituidos.push(outro);
      }
    }
    substituidos.forEach((outro) => {
      outro.leave(chave);
      outro.data.room = null;
      outro.emit('derrubado');
      io.to(chave).emit('user-left', outro.id);
      setTimeout(() => outro.disconnect(true), 300);
    });

    const ocupantes = sala ? [...sala].filter((id) => !substituidos.some((s) => s.id === id)) : [];
    if (ocupantes.length >= MAX_PESSOAS) return reply({ ok: false, motivo: 'cheia' });

    const outros = ocupantes.map((id) => ({
      id,
      name: io.sockets.sockets.get(id)?.data.nome || 'PARTICIPANTE',
    }));

    socket.join(chave);
    socket.data.room = chave;

    socket.emit('existing-users', outros);
    socket.to(chave).emit('user-joined', { id: socket.id, name: socket.data.nome });
    reply({ ok: true });
  });

  // ===== Sinalização (conexão entre as pessoas) =====
  socket.on('signal', (payload) => {
    const { to, data } = payload || {};
    const chave = socket.data.room;
    if (!chave || !to) return;

    // Só repassa para quem está na mesma sala
    const sala = io.sockets.adapter.rooms.get(chave);
    if (!sala || !sala.has(to)) return;

    io.to(to).emit('signal', { from: socket.id, data });
  });

  // ===== Chat de texto =====
  socket.on('chat', (texto, responder) => {
    const reply = resposta(responder);
    const chave = socket.data.room;
    if (!chave) return reply({ ok: false, motivo: 'fora' });

    const limpo = String(texto || '').trim().slice(0, MAX_CHARS_CHAT);
    if (!limpo) return reply({ ok: false, motivo: 'vazia' });

    // No máximo 5 mensagens a cada 5 segundos por pessoa
    const agora = Date.now();
    socket.data.envios = (socket.data.envios || []).filter((t) => agora - t < 5000);
    if (socket.data.envios.length >= 5) return reply({ ok: false, motivo: 'devagar' });
    socket.data.envios.push(agora);

    io.to(chave).emit('chat-msg', {
      id: socket.id,
      name: socket.data.nome,
      text: limpo,
      hora: agora,
    });
    reply({ ok: true });
  });

  socket.on('disconnect', () => {
    if (socket.data.room) {
      socket.to(socket.data.room).emit('user-left', socket.id);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
