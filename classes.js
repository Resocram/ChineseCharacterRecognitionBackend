const DATA = require("./wordBank.json")
const WebSocket = require('ws');

class GameRoomManager {
    constructor() {
        // Key is roomId, Value is Game
        this.rooms = new Map();
    }

    generateRoomId() {
        const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';

        for (let i = 0; i < 4; i++) {
            const randomIndex = Math.floor(Math.random() * letters.length);
            result += letters.charAt(randomIndex);
        }

        return result;
    }

    createRoom() {
        let roomId = this.generateRoomId();
        while (this.roomExists(roomId)) {
            roomId = this.generateRoomId()
        }
        this.rooms.set(roomId, new Game())
        return roomId
    }

    getRoom(roomId) {
        if (this.roomExists(roomId)) {
            return this.rooms.get(roomId)
        }
        console.log("Room ID does not exist")
        return null
    }

    roomExists(roomId) {
        return this.rooms.has(roomId)
    }

    maybeDelete(roomId) {
        const room = this.getRoom(roomId)
        if (room && (room.sessions.length === 0)) {
            this.rooms.delete(roomId)
        }
        return
    }
}

const LOBBY = "LOBBY";
const PLAY = "PLAY";
const GAME_OVER = "GAME_OVER"

class Game {
    constructor() {
        this.difficultyStart = 0
        this.difficultyEnd = 1000
        this.problems = []
        this.round = 1 
        this.colours = [
            '#00C3E3', // Light Blue (I block)
            '#52D017', // Green (S block)
            '#F7D308', // Yellow (O block)
            '#A05ACF', // Purple (T block)
            '#F68F1E', // Orange (L block)
            '#ED2939', // Red (Z block)
            '#0E6AC4', // Blue (J block)
          ]
        // Key is sessionId, Value is Player
        this.sessions = new Map()
        this.state = LOBBY
    }

    createPlayer(sessionId) {
        if (this.playerExists(sessionId)) {
            return this.getPlayer(sessionId)
        } else {
            const usedColours = Array.from(this.sessions.values()).map(p => p.colour);
            let playerColour = this.colours[this.sessions.size % this.colours.length];
            if (usedColours.includes(playerColour)) {
                const availableColour = this.colours.find(c => !usedColours.includes(c));
                if (availableColour) {
                    playerColour = availableColour;
                } else {
                    playerColour = '#' + Math.floor(Math.random()*16777215).toString(16);
                }
            }
            this.sessions.set(sessionId, new Player(playerColour)) 
        }
        return this.getPlayer(sessionId)
    }

    getPlayer(sessionId) {
        if (this.playerExists(sessionId)) {
            return this.sessions.get(sessionId)
        }
        console.log("Session ID does not exist")
        return null
    }

    playerExists(sessionId) {
        return this.sessions.has(sessionId)
    }

    getAllPlayers() {
        return Array.from(this.sessions.values(), player => player.username);
    }


    // Check if player has any active connections, if not then delete
    maybeDelete(sessionId) {
        const player = this.getPlayer(sessionId)
        if (player && (player.ws.length === 0)) {
            this.sessions.delete(sessionId)
        }
        return
    }

    shuffleArray(array) {
        const slicedArray = [...array];

        for (let i = slicedArray.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [slicedArray[i], slicedArray[j]] = [slicedArray[j], slicedArray[i]];
        }

        return slicedArray;
    }

    incrementRound() {
        this.round += 1
    }

    shouldNext() {
        return Array.from(this.sessions.values()).every(player => player.next === true);
    }
    resetNext() {
        this.sessions.forEach(player => {
            player.next = false;
        });
    }

    isGameOver() {
        if(this.problems.length === (this.round - 1)){
            this.state = GAME_OVER
            return true
        }
        return false
    }

    // BROADCAST FUNCTIONS
    broadcastUpdatePlayers() {
        let position = 0
        const sessionsObj = {};
        this.sessions.forEach((player, sessionId) => {
            sessionsObj[sessionId] = player;
        });
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update_players', sessions: JSON.stringify(sessionsObj), position: position }));
                }
            })
            position += 1
        })
    }

    broadcastStart(difficultyStart, difficultyEnd) {
        this.difficultyStart = difficultyStart
        this.difficultyEnd = difficultyEnd
        this.state = PLAY
        this.problems = this.shuffleArray(DATA.slice(difficultyStart, difficultyEnd))
        this.resetNext()
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'start_game', problems: this.problems, round: this.round }));
                }
            })
        })
        this.broadcastSkipVotes()
    }

    broadcastStrokes(sessionId, strokes) {
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update_strokes', sessionId: sessionId, strokes: strokes }));
                }
            })
        })
    }

    broadcastRound(correct_player) {
        const sessionsObj = {};
        this.sessions.forEach((player, sessionId) => {
            sessionsObj[sessionId] = player;
        });
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update_round', sessions: JSON.stringify(sessionsObj), correct_player: correct_player, round: this.round, gameOver: this.isGameOver() }));
                }
            })
        })
        this.resetNext()
        this.broadcastSkipVotes()
    }

    broadcastSkipVotes() {
        const skippedCount = Array.from(this.sessions.values()).filter(player => player.next).length;
        const totalCount = this.sessions.size;
        
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'update_skip_votes', skippedCount, totalCount }));
                }
            })
        })
    }

    broadcastInitialSkipVotes() {
        this.broadcastSkipVotes();
    }


}


class Player {
    constructor(colour = "#000000") {
        this.username = ""
        this.score = 0
        this.ws = []
        this.strokes = []
        this.next = false
        this.colour = colour
    }

    addConnection(connection) {
        this.ws.push(connection)
        return
    }

    removeConnection(connection) {
        const index = this.ws.indexOf(connection)
        this.ws.splice(index, 1)
        return
    }

    updateUsername(username) {
        this.username = username
        return
    }

    incrementScore() {
        this.score += 1
    }

    goNext() {
        this.next = !this.next;
    }
}


module.exports = { GameRoomManager, Game, Player };