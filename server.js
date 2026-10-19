const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Pool } = require('pg');
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

// O endereço do banco fica guardado no Render, na variável DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});
pool.on('error', (e) => console.error('Erro no banco de dados:', e.message));

app.use(express.static('public'));

const sessoes = new Map();     // token -> { chave, expira }
const tentativas = new Map();  // chave -> { falhas, bloqueadoAte }

setInterval(() => {
  const agora = Date.now();
  for (const [token, s] of sessoes) {
    if (s.expira < agora) sessoes.delete(token);
  }
}, 60 * 60 * 1000);

// Remove acentos e põe em maiúsculas: "JOÃO" e "JOAO" viram o mesmo usuário
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

async function buscarConta(chave) {
  const r = await pool.query('SELECT chave, nome, salt, hash FROM contas WHERE chave = $1', [chave]);
  return r.rows[0] || null;
}

function criarSessao(chave) {
  const token = crypto.randomBytes(32).toString('hex');
  sessoes.set(token, { chave, expira: Date.now() + DIAS_SESSAO * 24 * 60 * 60 * 1000 });
  return token;
}

function ligarUsuario(socket, conta) {
  socket.data.chave = conta.chave;
  socket.data.nome = conta.nome;
}

io.on('connection', (socket) => {
  const resposta = (responder) => (typeof responder === 'function' ? responder : () => {});

  // ===== Criar conta =====
  socket.on('cadastrar', async (dados, responder) => {
    const reply = resposta(responder);
    try {
      const nome = String(dados?.usuario || '').trim().toUpperCase();
      const senha = String(dados?.senha || '');

      if (!usuarioValido(nome)) return reply({ ok: false, motivo: 'nome' });
      if (!senhaValida(senha)) return reply({ ok: false, motivo: 'senha' });

      const chave = chaveDe(nome);
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = gerarHash(senha, salt);

      // ON CONFLICT: se o nome já existir, nada é gravado (impede duas contas com o mesmo nome)
      const r = await pool.query(
        `INSERT INTO contas (chave, nome, salt, hash)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (chave) DO NOTHING
         RETURNING chave`,
        [chave, nome, salt, hash]
      );
      if (r.rowCount === 0) return reply({ ok: false, motivo: 'existe' });

      ligarUsuario(socket, { chave, nome });
      reply({ ok: true, nome, token: criarSessao(chave) });
    } catch (e) {
      console.error('Erro ao criar conta:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  // ===== Entrar na conta =====
  socket.on('entrar', async (dados, responder) => {
    const reply = resposta(responder);
    try {
      const nome = String(dados?.usuario || '').trim().toUpperCase();
      const senha = String(dados?.senha || '').slice(0, 100);
      const chave = chaveDe(nome);

      const t = tentativas.get(chave) || { falhas: 0, bloqueadoAte: 0 };
      if (t.bloqueadoAte > Date.now()) return reply({ ok: false, motivo: 'bloqueado' });

      const conta = await buscarConta(chave);
      if (!conta || !senhaCorreta(conta, senha)) {
        t.falhas += 1;
        if (t.falhas >= MAX_TENTATIVAS) {
          t.bloqueadoAte = Date.now() + BLOQUEIO_MS;
          t.falhas = 0;
        }
        tentativas.set(chave, t);
        return reply({ ok: false, motivo: 'dados' });
      }

      tentativas.delete(chave);
      ligarUsuario(socket, conta);
      reply({ ok: true, nome: conta.nome, token: criarSessao(chave) });
    } catch (e) {
      console.error('Erro ao entrar:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  // ===== Reconectar com a sessão salva no navegador =====
  socket.on('retomar', async (token, responder) => {
    const reply = resposta(responder);
    try {
      const s = sessoes.get(String(token || ''));
      if (!s || s.expira < Date.now()) return reply({ ok: false });

      const conta = await buscarConta(s.chave);
      if (!conta) return reply({ ok: false });

      ligarUsuario(socket, conta);
      reply({ ok: true, nome: conta.nome });
    } catch (e) {
      console.error('Erro ao retomar sessão:', e.message);
      reply({ ok: false });
    }
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

    // Se a mesma conta já estiver na sala em outra aba ou aparelho, a conexão antiga é encerrada
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

// Cria a tabela de contas sozinho, se ela ainda não existir
async function iniciar() {
  if (!process.env.DATABASE_URL) {
    throw new Error('A variável DATABASE_URL não está configurada no Render (Environment).');
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contas (
      chave TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      salt TEXT NOT NULL,
      hash TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
}

iniciar().catch((e) => {
  console.error('Erro ao iniciar o servidor:', e.message);
  process.exit(1);
});
