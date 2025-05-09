const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const cors = require('cors');
const { GameRoomManager } = require('./classes.js');
// Create an array to store game rooms
const gameRoomManager = new GameRoomManager();

app.use(
  cors({
    origin: ['https://resocram.github.io', 'http://localhost:3000'],
  })
);

app.get('/', (req, res) => {
  res.send("SERVER IS RUNNING")
})

app.post('/api/create-multiplayer', (req, res) => {
  const roomId = gameRoomManager.createRoom();
  res.send({ roomId });
});

app.get('/api/check-room/:roomId', (req, res) => {
  const roomId = req.params.roomId;
  const exists = gameRoomManager.roomExists(roomId)
  res.send({ exists });
});

wss.on('connection', (ws, req) => {
  const params = req.url.split('/')
  const roomId = params[1]
  const sessionId = params[2]

  const game = gameRoomManager.getRoom(roomId)

  if (!game) {
    console.log("Room not found")
    return
  }

  const player = game.createPlayer(sessionId)
  player.addConnection(ws)

  ws.on('message', (message) => {

    const data = JSON.parse(message);

    switch (data.type) {
      case 'update_player':
        const username = data.username;
        player.updateUsername(username)
        game.broadcastUpdatePlayers();
        break;
      case 'start_game':
        let difficulty = data.difficulty
        game.broadcastStart(difficulty[0], difficulty[1])
        break;
      case 'send_strokes':
        const strokes = data.strokes
        game.broadcastStrokes(sessionId, strokes)
        break;
      case 'correct_guess':
        player.incrementScore()
        game.incrementRound()
        game.broadcastRound(player)
        break;
      case 'vote_next':
        player.goNext()
        if (game.shouldNext()) {
          game.resetNext()
          game.incrementRound()
          game.broadcastRound(null)
        }
        break;
      default:
        break;
    }
  });

  // Remove websocket connection upon close
  ws.on('close', () => {
    player.removeConnection(ws)
    game.maybeDelete(sessionId)
    gameRoomManager.maybeDelete(roomId)
    game.broadcastUpdatePlayers();
  });

  ws.on('error', (error) => {
    console.error("WebSocket error:", error);
  });

});



let port = process.env.PORT || 5000
server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});