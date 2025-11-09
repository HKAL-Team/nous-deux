import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient(); // Keep it global, but calls must be guarded in Next.js components

const SKIP_REDIS_CONNECTION = process.env.SKIP_REDIS_CONNECTION === 'true';
const redisHost = process.env.REDIS_HOST || '127.0.0.1';
const redisPort = process.env.REDIS_PORT || 6379;

let pubClient, subClient;
if (!SKIP_REDIS_CONNECTION) {
  pubClient = createClient({ url: `redis://${redisHost}:${redisPort}` });
  subClient = pubClient.duplicate();
}

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const cleanupTimers = new Map();

app.prepare().then(async () => {
  let redisClientServer;

  if (!SKIP_REDIS_CONNECTION) {
    redisClientServer = createClient({
      url: process.env.REDIS_URL || `redis://${redisHost}:${redisPort}`,
    });

    redisClientServer.on('error', (err) =>
      console.error('Redis Client Error', err)
    );
    await redisClientServer.connect();
  } else {
    console.warn('⚠️ SKIP_REDIS_CONNECTION est actif. Les services de jeu seront désactivés pour le build.');
  }

  const server = createServer((req, res) => {
    const urlStr = req.url ?? '/';
    const parsedUrl = parse(urlStr, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(server, {
    cors: {
      origin: '*',
    },
  });

  if (!SKIP_REDIS_CONNECTION) {
    const pubClientIO = redisClientServer.duplicate();
    const subClientIO = redisClientServer.duplicate();
    await Promise.all([pubClientIO.connect(), subClientIO.connect()]);
    io.adapter(createAdapter(pubClientIO, subClientIO));
  }

  io.on('connection', async (socket) => {
    console.log('🟢 Connected:', socket.id);

    const isGameServiceReady = !SKIP_REDIS_CONNECTION && redisClientServer;

    const updateOnlinePlayers = async () => {
      const sockets = await io.fetchSockets();
      io.emit('online:connected', sockets.length);
    };

    await updateOnlinePlayers();

    socket.on('create-room', async ({ }) => { }); // Not implemented yet

    /** Handle local events **/
    socket.on('local:join-room', async ({ roomId, player1, player2 }) => {
      if (!isGameServiceReady) {
        return socket.emit('local:error_join-room', 'Service de jeu indisponible (build ou maintenance)');
      }
      if (!roomId || !player1?.username || !player2?.username) {
        return socket.emit(
          'local:error_join-room',
          'roomId ou joueurs manquants'
        );
      }

      socket.join(roomId);

      try {
        const sessionKey = `session:${roomId}`;
        const rawSession = await redisClientServer.get(sessionKey);

        if (!rawSession) {
          socket.emit('local:error_join-room', 'Session introuvable');
          return;
        }

        const session = JSON.parse(rawSession);

        const existingUsernames = session.players.map((p) => p.username);
        const players = [...session.players];

        if (!existingUsernames.includes(player1.username)) {
          players.push({
            socketId: socket.id,
            username: player1.username,
            isHost: true,
            isOnline: true,
            points: 0,
          });
        } else {
          players.forEach((p) => {
            if (p.username === player1.username) {
              p.socketId = socket.id;
              p.isOnline = true;
            }
          });
        }

        if (!existingUsernames.includes(player2.username)) {
          players.push({
            socketId: null,
            username: player2.username,
            isHost: false,
            isOnline: true,
            points: 0,
          });
        }

        session.players = players;

        if (session.currentGameId == null) {
          session.status = 'in_game_selection_menu';
        }

        if (cleanupTimers.has(roomId)) {
          clearTimeout(cleanupTimers.get(roomId));
          cleanupTimers.delete(roomId);
        }

        await redisClientServer.set(sessionKey, JSON.stringify(session));
        io.to(roomId).emit('local:players-ready', session);
      } catch (err) {
        console.error('❌ Erreur local:join-room:', err);
        socket.emit(
          'local:error_join-room',
          'Erreur lors de la jointure de la room'
        );
      }
    });

    socket.on('local:start-game', async ({ mode, roomId }) => {
      if (!isGameServiceReady) {
        return socket.emit('local:error_start-game', 'Service de jeu indisponible (build ou maintenance)');
      }
      if (!mode || !roomId) {
        return socket.emit('local:error_start-game', 'Mode ou roomId manquant');
      }

      try {
        const sessionKey = `session:${roomId}`;
        const rawSession = await redisClientServer.get(sessionKey); 
        if (!rawSession) {
          return socket.emit('local:error_start-game', 'Session introuvable');
        }

        const session = JSON.parse(rawSession);
        const usedQuestions = session.usedQuestions || [];

        let allQuestions = await prisma.question.findMany({
                    where: {
                        mode,
                        id: { notIn: usedQuestions },
                    },
                });

        // ... (reste de la logique de jeu)

        function getRandomItems(arr, n) {
          return arr.sort(() => Math.random() - 0.5).slice(0, n);
        }

        let questions = getRandomItems(allQuestions, 20);

        if (questions.length === 0) {
          const fallbackContents = [
            "Dis à quel point tu aimes 'nous deux'.",
            'Peut-être tu devrais regarder si la base est bien setup.',
            'Tu ne devrais pas voir cette question dans la DB.',
            'T’es sûr que t’as bien tout configuré ?',
            "Décris un moment qui représente 'nous deux'.",
            "Si 'nous deux' était un film, ce serait quoi ?",
            "Imagine un futur parfait pour 'nous deux'.",
            "Quel est ton souvenir préféré de 'nous deux' ?",
            "Qu’est-ce que tu ressens quand tu penses à 'nous deux' ?",
            "Si tu devais convaincre quelqu’un que 'nous deux' est spécial, tu dirais quoi ?",
            "Qu’est-ce que tu dirais à 'nous deux' si c’était une personne ?",
            "Quel emoji représente le mieux 'nous deux' ?",
            "Quelle chanson te fait penser à 'nous deux' ?",
            "Raconte une anecdote drôle sur 'nous deux'.",
            "Qu’est-ce que tu changerais à 'nous deux' ?",
            "Comment vois-tu 'nous deux' dans 10 ans ?",
            "Si 'nous deux' était un plat, ce serait quoi ?",
            "Complète la phrase : 'J’aime nous deux parce que…'",
            "Qu’est-ce que 'nous deux' t’a appris ?",
            "Quelle photo représente le mieux 'nous deux' ?",
          ];

          questions = fallbackContents.map((content) => ({
            id: uuidv4(),
            content,
            type: 'QUESTION',
            mode,
            points: 0,
          }));
        }

        const newUsedQuestions = [
          ...usedQuestions,
          ...questions.map((q) => q.id),
        ];

        session.usedQuestions = newUsedQuestions;

        const gameId = crypto.randomUUID();
        const gameKey = `game:${gameId}`;

        const gameData = {
          id: gameId,
          mode,
          roomId,
          startedAt: Date.now(),
          currentRound: 1,
          questions,
        };

        await redisClientServer.set(gameKey, JSON.stringify(gameData));

        session.status = 'in_game';
        session.currentGameId = gameId;

        await redisClientServer.set(sessionKey, JSON.stringify(session));

        io.to(roomId).emit('local:game-started', { gameId });
      } catch (err) {
        console.error('❌ Erreur local:start-game:', err);
        socket.emit(
          'local:error_start-game',
          'Erreur lors du démarrage du jeu'
        );
      }
    });

    socket.on('local:answer', async ({ gameId, accepted }) => {
      if (!isGameServiceReady) {
        return socket.emit('local:error', 'Service de jeu indisponible (build ou maintenance)');
      }
      if (!gameId || typeof accepted !== 'boolean') {
        return socket.emit('local:error', 'Paramètres invalides');
      }

      const gameKey = `game:${gameId}`;
      const rawGame = await redisClientServer.get(gameKey); 
      if (!rawGame) return socket.emit('local:error', 'Partie introuvable');

      const game = JSON.parse(rawGame);

      const sessionKey = `session:${game.roomId}`;
      const rawSession = await redisClientServer.get(sessionKey); 
      if (!rawSession) return socket.emit('local:error', 'Session introuvable');
      const session = JSON.parse(rawSession);

      const round = game.currentRound;

      const question = game.questions[round - 1];
      if (!question) return socket.emit('local:error', 'Question introuvable');

      const playerIndexAnswering = round % 2 === 1 ? 0 : 1;

      if (accepted) {
        session.players[playerIndexAnswering].points += question.points;
      }

      game.currentRound += 1;

      await redisClientServer.set(gameKey, JSON.stringify(game));
      await redisClientServer.set(sessionKey, JSON.stringify(session));

      io.to(session.room).emit('local:update-score', {
        players: session.players,
      });

      if (game.currentRound > 20) {
        session.currentGameId = null;
        await redisClientServer.set(sessionKey, JSON.stringify(session));
        await redisClientServer.del(`game:${game.id}`);

        io.to(session.room).emit('local:end-game', {
          players: session.players,
        });
      } else {
        const nextQuestion = game.questions[game.currentRound - 1];
        io.to(session.room).emit('local:next-round', {
          currentRound: game.currentRound,
          question: nextQuestion,
        });
      }
    });

    socket.on('local:player-leave', async ({ roomId }) => {
      if (!isGameServiceReady) {
        return console.warn('Tentative de déconnexion pendant le build ignorée.');
      }
      console.log('local:player-leave', roomId, socket.id);
      const roomSockets = io.sockets.adapter.rooms.get(roomId);
      const sessionKey = `session:${roomId}`;
      const rawSession = await redisClientServer.get(sessionKey); 
      if (!rawSession) return socket.emit('local:error', 'Session introuvable');
      const session = JSON.parse(rawSession);

      if (!roomSockets || roomSockets.size === 0) {
        const timer = setTimeout(async () => {
          await redisClientServer.del(`session:${roomId}`);
          await redisClientServer.del(`game:${session.currentGameId}`);
          cleanupTimers.delete(roomId);
        }, 60000);

        cleanupTimers.set(roomId, timer);
      }
    });

    socket.on('online:join-room', async ({ roomId, player }) => {
      if (!isGameServiceReady) {
        return socket.emit('online:error_join-room', 'Service de jeu indisponible (build ou maintenance)');
      }
      if (!roomId || !player?.username) {
        return socket.emit(
          'online:error_join-room',
          'roomId ou joueur manquants'
        );
      }

      socket.join(roomId);

      try {
        const sessionKey = `session:${roomId}`;
        const rawSession = await redisClientServer.get(sessionKey); 

        if (!rawSession) {
          socket.emit('online:error_join-room', 'Session introuvable');
          return;
        }

        const session = JSON.parse(rawSession);
        const { username } = player;

        const newPlayer = {
          socketId: socket.id,
          username: username,
          isHost: session.players.length === 0 ? true : false,
          isOnline: true,
          points: 0,
        };

        session.players.push(newPlayer);

        await redisClientServer.set(sessionKey, JSON.stringify(session));

        socket.to(roomId).emit('online:player-joined', {
          player: newPlayer,
        });

        if (session.players.length === 2) {
          io.to(roomId).emit('online:players-ready', {
            player1: session.players[0],
            player2: session.players[1],
          });
        }

        console.log(`🔗 ${username} joined room ${roomId}`);
      } catch (err) {
        console.error('❌ Erreur online:error_join-room:', err);
        socket.emit(
          'online:error_join-room;',
          'Erreur lors de la jointure de la room'
        );
      }
    });

    socket.on('get:game-info', async () => {
      console.log('get:game-info');
      const totalQuestions = await prisma.question.count();
      socket.emit('response:game-info', { totalQuestions });
    });

    socket.on('disconnect', async () => {
      await updateOnlinePlayers();
      console.log('❌ Disconnected:', socket.id);
    });
  });

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`🚀 Ready on http://localhost:${PORT}`);
  });
});