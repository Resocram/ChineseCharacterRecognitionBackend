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
        if (room && (room.sessions.size === 0)) {
            this.rooms.delete(roomId)
        }
        return
    }
}

// How long to keep a disconnected player's score/history around in case it was just a page refresh
const DISCONNECT_GRACE_MS = 30000;

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
        // Chronological list of past round outcomes, sent to reconnecting clients so refreshing doesn't lose history
        this.roundHistory = []
    }

    createPlayer(sessionId) {
        if (this.playerExists(sessionId)) {
            const player = this.getPlayer(sessionId)
            player.cancelRemoval()
            return player
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


    // Called when a connection closes. Rather than deleting the player (and their score)
    // immediately, wait a grace period so a page refresh can reconnect without losing state.
    scheduleDisconnectCleanup(sessionId, onRemoved) {
        const player = this.getPlayer(sessionId)
        if (!player) return
        player.cancelRemoval()
        player.removalTimer = setTimeout(() => {
            if (player.ws.length === 0) {
                this.sessions.delete(sessionId)
                if (onRemoved) onRemoved()
            }
        }, DISCONNECT_GRACE_MS)
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

    broadcastStart(difficultyStart, difficultyEnd, numRounds) {
        this.difficultyStart = difficultyStart
        this.difficultyEnd = difficultyEnd
        this.state = PLAY
        const pool = this.shuffleArray(DATA.slice(difficultyStart, difficultyEnd))
        const roundCount = Math.min(Math.max(Number(numRounds) || pool.length, 1), pool.length)
        this.problems = pool.slice(0, roundCount)
        this.roundHistory = []
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
        const completedProblem = this.problems[this.round - 2]
        if (completedProblem) {
            this.roundHistory.push({ answer: completedProblem, colour: correct_player ? correct_player.colour : null })
        }
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

    // Resets the room to the lobby (fresh scores/round) so the same players can start another game
    broadcastReturnToLobby() {
        this.state = LOBBY
        this.round = 1
        this.problems = []
        this.roundHistory = []
        this.resetNext()
        this.sessions.forEach((player) => {
            player.score = 0
        })
        const sessionsObj = Object.fromEntries(this.sessions)
        this.sessions.forEach((player) => {
            player.ws.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({ type: 'return_to_lobby', sessions: JSON.stringify(sessionsObj) }));
                }
            })
        })
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
        this.removalTimer = null
    }

    addConnection(connection) {
        this.ws.push(connection)
        return
    }

    cancelRemoval() {
        if (this.removalTimer) {
            clearTimeout(this.removalTimer)
            this.removalTimer = null
        }
    }

    removeConnection(connection) {
        const index = this.ws.indexOf(connection)
        if (index !== -1) {
            this.ws.splice(index, 1)
        }
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

    // Excludes non-serializable/internal fields (ws sockets, removalTimer) from broadcasts
    toJSON() {
        const { username, score, strokes, next, colour } = this
        return { username, score, strokes, next, colour }
    }
}


module.exports = { GameRoomManager, Game, Player, LOBBY, PLAY, GAME_OVER };