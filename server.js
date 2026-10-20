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

// Versão do código. No Render, RENDER_GIT_COMMIT muda a cada atualização no GitHub.
// Quando ela muda, as páginas abertas mostram a tela de atualização e recarregam.
const VERSAO = process.env.RENDER_GIT_COMMIT || String(Date.now());

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
  avisarStatus(conta.chave);
}
// ===== Presença (quem está online) e amizades =====

// Todas as conexões abertas de uma conta
function socketsDaConta(chave) {
  const lista = [];
  for (const s of io.sockets.sockets.values()) {
    if (s.data.chave === chave) lista.push(s);
  }
  return lista;
}

// A conta está online se tiver alguma conexão aberta (ignora a conexão que está saindo)
function estaOnline(chave, excluirId) {
  return socketsDaConta(chave).some((s) => s.id !== excluirId);
}

// Chaves dos amigos aceitos de uma conta
async function amigosDe(chave) {
  const r = await pool.query(
    `SELECT CASE WHEN solicitante = $1 THEN destinatario ELSE solicitante END AS chave
     FROM amizades
     WHERE status = 'aceito' AND (solicitante = $1 OR destinatario = $1)`,
    [chave]
  );
  return r.rows.map((x) => x.chave);
}

// Avisa os amigos de uma conta quando ela fica online ou offline
function avisarStatus(chave, excluirId) {
  const online = estaOnline(chave, excluirId);
  amigosDe(chave)
    .then((lista) => {
      lista.forEach((amigo) => {
        socketsDaConta(amigo).forEach((s) => s.emit('amigo-status', { chave, online }));
      });
    })
    .catch((e) => console.error('Erro ao avisar status:', e.message));
}

// Avisa as contas indicadas para atualizarem a lista de amigos
function avisarAmizade(chaves) {
  chaves.forEach((c) => socketsDaConta(c).forEach((s) => s.emit('amizade-atualizada')));
}
io.on('connection', (socket) => {
  // Envia a versão logo ao conectar, para a página saber se o código mudou
  socket.emit('versao', VERSAO);

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
    if (socket.data.chave) avisarStatus(socket.data.chave, socket.id);
    socket.data.chave = null;
    socket.data.nome = null;
    reply({ ok: true });
  });
  // ===== Amigos =====

  // Lista de amigos (com online), pedidos recebidos e pedidos enviados
  socket.on('amigos-listar', async (responder) => {
    const reply = resposta(responder);
    const eu = socket.data.chave;
    if (!eu) return reply({ ok: false, motivo: 'login' });
    try {
      const r = await pool.query(
        `SELECT a.solicitante, a.destinatario, a.status, c.nome, p.dados
         FROM amizades a
         JOIN contas c ON c.chave = (CASE WHEN a.solicitante = $1 THEN a.destinatario ELSE a.solicitante END)
         LEFT JOIN perfis p ON p.chave = c.chave
         WHERE a.solicitante = $1 OR a.destinatario = $1
         ORDER BY c.nome`,
        [eu]
      );
      const amigos = [];
      const recebidos = [];
      const enviados = [];
      r.rows.forEach((x) => {
        const outro = x.solicitante === eu ? x.destinatario : x.solicitante;
        const item = { chave: outro, nome: x.nome, perfil: x.dados || {} };
        if (x.status === 'aceito') amigos.push({ ...item, online: estaOnline(outro) });
        else if (x.destinatario === eu) recebidos.push(item);
        else enviados.push(item);
      });
      reply({ ok: true, amigos, recebidos, enviados });
    } catch (e) {
      console.error('Erro ao listar amigos:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  // Envia um pedido de amizade
  socket.on('amigo-pedir', async (usuario, responder) => {
    const reply = resposta(responder);
    const eu = socket.data.chave;
    if (!eu) return reply({ ok: false, motivo: 'login' });
    try {
      const alvo = chaveDe(usuario);
      if (!alvo) return reply({ ok: false, motivo: 'nao_existe' });
      if (alvo === eu) return reply({ ok: false, motivo: 'proprio' });

      const conta = await buscarConta(alvo);
      if (!conta) return reply({ ok: false, motivo: 'nao_existe' });

      const existe = await pool.query(
        `SELECT status FROM amizades
         WHERE (solicitante = $1 AND destinatario = $2) OR (solicitante = $2 AND destinatario = $1)`,
        [eu, alvo]
      );
      if (existe.rowCount > 0) {
        return reply({ ok: false, motivo: existe.rows[0].status === 'aceito' ? 'ja_amigo' : 'ja_pedido' });
      }

      await pool.query(
        `INSERT INTO amizades (solicitante, destinatario, status) VALUES ($1, $2, 'pendente')`,
        [eu, alvo]
      );
      avisarAmizade([alvo]);
      reply({ ok: true, nome: conta.nome });
    } catch (e) {
      console.error('Erro ao pedir amizade:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  // Aceita ou recusa um pedido que você recebeu
  socket.on('amigo-responder', async (dados, responder) => {
    const reply = resposta(responder);
    const eu = socket.data.chave;
    if (!eu) return reply({ ok: false, motivo: 'login' });
    try {
      const quem = chaveDe(dados && dados.usuario);
      if (dados && dados.aceitar) {
        await pool.query(
          `UPDATE amizades SET status = 'aceito'
           WHERE solicitante = $1 AND destinatario = $2 AND status = 'pendente'`,
          [quem, eu]
        );
      } else {
        await pool.query(
          `DELETE FROM amizades
           WHERE solicitante = $1 AND destinatario = $2 AND status = 'pendente'`,
          [quem, eu]
        );
      }
      avisarAmizade([quem, eu]);
      reply({ ok: true });
    } catch (e) {
      console.error('Erro ao responder pedido:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  // Remove um amigo ou cancela um pedido (enviado ou recebido)
  socket.on('amigo-remover', async (usuario, responder) => {
    const reply = resposta(responder);
    const eu = socket.data.chave;
    if (!eu) return reply({ ok: false, motivo: 'login' });
    try {
      const outro = chaveDe(usuario);
      await pool.query(
        `DELETE FROM amizades
         WHERE (solicitante = $1 AND destinatario = $2) OR (solicitante = $2 AND destinatario = $1)`,
        [eu, outro]
      );
      avisarAmizade([outro, eu]);
      reply({ ok: true });
    } catch (e) {
      console.error('Erro ao remover amigo:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });
    // ===== Servidores =====

  socket.on('servidor-criar', async (nome, responder) => {
    const reply = resposta(responder);
    if (!socket.data.chave) return reply({ ok: false, motivo: 'login' });

    try {
      nome = String(nome || '').trim().slice(0, 40);
      if (!nome) return reply({ ok: false, motivo: 'nome' });

      const id = 'SRV-' + crypto.randomBytes(6).toString('hex').toUpperCase();
      const convite = crypto.randomBytes(4).toString('hex').toUpperCase();

      const resultado = await pool.query(
        `INSERT INTO servidores (id, nome, convite, dono)
         VALUES ($1, $2, $3, $4)
         RETURNING id, nome, convite`,
        [id, nome, convite, socket.data.chave]
      );

      await pool.query(
        `INSERT INTO servidor_membros (servidor_id, usuario)
         VALUES ($1, $2)`,
        [id, socket.data.chave]
      );

      reply({ ok: true, servidor: resultado.rows[0] });
    } catch (e) {
      console.error('Erro ao criar servidor:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  socket.on('servidores-listar', async (responder) => {
    const reply = resposta(responder);
    if (!socket.data.chave) return reply({ ok: false, motivo: 'login' });

    try {
      const resultado = await pool.query(
        `SELECT s.id, s.nome, s.convite, s.dono
         FROM servidores s
         JOIN servidor_membros m ON m.servidor_id = s.id
         WHERE m.usuario = $1
         ORDER BY s.criado_em`,
        [socket.data.chave]
      );

      reply({ ok: true, servidores: resultado.rows });
    } catch (e) {
      console.error('Erro ao listar servidores:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });

  socket.on('servidor-entrar-convite', async (convite, responder) => {
    const reply = resposta(responder);
    if (!socket.data.chave) return reply({ ok: false, motivo: 'login' });

    try {
      convite = String(convite || '').trim().toUpperCase();

      const resultado = await pool.query(
        `SELECT id, nome, convite, dono
         FROM servidores
         WHERE convite = $1`,
        [convite]
      );

      const servidor = resultado.rows[0];
      if (!servidor) return reply({ ok: false, motivo: 'convite' });

      await pool.query(
        `INSERT INTO servidor_membros (servidor_id, usuario)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [servidor.id, socket.data.chave]
      );

      reply({ ok: true, servidor });
    } catch (e) {
      console.error('Erro ao entrar no servidor:', e.message);
      reply({ ok: false, motivo: 'erro' });
    }
  });
  // ===== Entrar na sala =====
  socket.on('join-room', async (room, responder) => {
    const reply = resposta(responder);
    if (!socket.data.chave) return reply({ ok: false, motivo: 'login' });
    if (socket.data.room) return reply({ ok: true });

        const nomeSala = String(room || '').trim().toUpperCase().slice(0, 40);
    if (!nomeSala) return reply({ ok: false, motivo: 'dados' });

    // Salas com prefixo SRV- pertencem a servidores cadastrados.
    // Só membros daquele servidor podem entrar.
    if (nomeSala.startsWith('SRV-')) {
      try {
        const membro = await pool.query(
          `SELECT 1
           FROM servidor_membros
           WHERE servidor_id = $1 AND usuario = $2`,
          [nomeSala, socket.data.chave]
        );

        if (!membro.rowCount) {
          return reply({ ok: false, motivo: 'sem_acesso' });
        }
      } catch (e) {
        console.error('Erro ao verificar membro do servidor:', e.message);
        return reply({ ok: false, motivo: 'erro' });
      }
    }

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
    if (socket.data.chave) avisarStatus(socket.data.chave, socket.id);
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS amizades (
      solicitante TEXT NOT NULL,
      destinatario TEXT NOT NULL,
      status TEXT NOT NULL,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (solicitante, destinatario)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS perfis (
      chave TEXT PRIMARY KEY,
      dados JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `);
    await pool.query(`
    CREATE TABLE IF NOT EXISTS servidores (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      convite TEXT UNIQUE NOT NULL,
      dono TEXT NOT NULL REFERENCES contas(chave) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS servidor_membros (
      servidor_id TEXT NOT NULL REFERENCES servidores(id) ON DELETE CASCADE,
      usuario TEXT NOT NULL REFERENCES contas(chave) ON DELETE CASCADE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (servidor_id, usuario)
    )
  `);
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} (versão ${VERSAO})`));
}

iniciar().catch((e) => {
  console.error('Erro ao iniciar o servidor:', e.message);
  process.exit(1);
});
