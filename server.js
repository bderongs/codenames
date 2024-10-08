const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Add this route to serve the main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'codenames.html'));
});

// Store active games
const games = new Map();

// Generate a random 6-character game ID
function generateGameId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const words = [
    'APPLE', 'BOOK', 'CAT', 'DOG', 'ELEPHANT', 'FISH', 'GUITAR', 'HOUSE', 'ICE', 'JACKET',
    'KING', 'LEMON', 'MOON', 'NINJA', 'OCEAN', 'PIANO', 'QUEEN', 'ROBOT', 'SUN', 'TREE',
    'UMBRELLA', 'VIOLIN', 'WATER', 'XYLOPHONE', 'YOGA', 'ZEBRA', 'AIRPLANE', 'BALLOON', 'CASTLE'
    // ... add more words to have at least 25 unique words
];

function createNewGame() {
    return {
        players: {
            red: { operatives: [], spymaster: null },
            blue: { operatives: [], spymaster: null }
        },
        board: generateBoard(),
        currentTurn: 'red',
        redCardsLeft: 9,
        blueCardsLeft: 8,
        clue: null,
        started: false
    };
}

function generateBoard() {
    const words = ['APPLE', 'BOOK', 'CAT', 'DOG', 'ELEPHANT', 'FISH', 'GUITAR', 'HOUSE', 'ICE', 'JACKET',
        'KING', 'LEMON', 'MOON', 'NINJA', 'OCEAN', 'PIANO', 'QUEEN', 'ROBOT', 'SUN', 'TREE',
        'UMBRELLA', 'VIOLIN', 'WATER', 'XYLOPHONE', 'YOGA'];
    const colors = ['red', 'blue', 'neutral', 'assassin'];
    const colorCounts = { red: 9, blue: 8, neutral: 7, assassin: 1 };

    return words.map(word => {
        let color;
        do {
            color = colors[Math.floor(Math.random() * colors.length)];
        } while (colorCounts[color] === 0);
        colorCounts[color]--;

        return { word, color, revealed: false };
    });
}

io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('createGame', () => {
        const gameId = generateGameId();
        games.set(gameId, createNewGame());
        console.log('Game created:', gameId);
        socket.emit('gameCreated', { gameId });
    });

    socket.on('joinGame', ({ gameId, team, role, playerName }) => {
        console.log('Join game requested:', gameId, team, role, playerName);
        const game = games.get(gameId);
        if (game) {
            const player = { id: socket.id, team, role, name: playerName };
            if (role === 'spymaster') {
                if (game.players[team].spymaster) {
                    socket.emit('error', 'Spymaster role is already taken for this team');
                    return;
                }
                game.players[team].spymaster = player;
            } else {
                game.players[team].operatives.push(player);
            }
            socket.join(gameId);
            console.log('Player joined game:', gameId);
            const gameState = getGameState(game, player);
            console.log('Sending initial game state to player:', gameState);
            socket.emit('gameJoined', { gameId, ...gameState });
            io.to(gameId).emit('updatePlayerList', getPlayerList(game));
        } else {
            console.log('Game not found:', gameId);
            socket.emit('error', 'Game not found');
        }
    });

    socket.on('revealCard', ({ gameId, cardIndex }) => {
        const game = games.get(gameId);
        if (game && game.started) {
            const player = getPlayerFromGame(game, socket.id);
            if (player && player.team === game.currentTurn && player.role === 'operative') {
                const card = game.board[cardIndex];
                if (!card.revealed) {
                    card.revealed = true;
                    if (card.color === 'assassin') {
                        game.winner = game.currentTurn === 'red' ? 'blue' : 'red';
                    } else if (card.color !== game.currentTurn) {
                        game.currentTurn = game.currentTurn === 'red' ? 'blue' : 'red';
                    }
                    if (card.color === 'red') game.redCardsLeft--;
                    if (card.color === 'blue') game.blueCardsLeft--;
                    if (game.redCardsLeft === 0) game.winner = 'red';
                    if (game.blueCardsLeft === 0) game.winner = 'blue';
                    io.to(gameId).emit('gameStateUpdate', getGameState(game));
                }
            }
        }
    });

    socket.on('submitClue', ({ gameId, clue, number }) => {
        console.log('Clue submitted:', gameId, clue, number);
        const game = games.get(gameId);
        if (game && game.started) {
            const player = getPlayerFromGame(game, socket.id);
            if (player && player.team === game.currentTurn && player.role === 'spymaster') {
                game.clue = { word: clue, number: parseInt(number) };
                console.log('Game state after clue submission:', game);
                const gameState = getGameState(game);
                console.log('Sending game state update to all players in room:', gameId);
                io.to(gameId).emit('gameStateUpdate', gameState);
            }
        }
    });

    socket.on('startGame', ({ gameId }) => {
        console.log('Start game requested for game:', gameId);
        const game = games.get(gameId);
        if (game && !game.started) {
            if (canStartGame(game)) {
                game.started = true;
                game.board = generateBoard();
                game.currentTurn = Math.random() < 0.5 ? 'red' : 'blue';
                console.log('Game started:', gameId);

                // Send personalized game state to each player
                for (const team of ['red', 'blue']) {
                    if (game.players[team].spymaster) {
                        const spymasterState = getGameState(game, game.players[team].spymaster);
                        io.to(game.players[team].spymaster.id).emit('gameStarted', spymasterState);
                    }
                    for (const operative of game.players[team].operatives) {
                        const operativeState = getGameState(game, operative);
                        io.to(operative.id).emit('gameStarted', operativeState);
                    }
                }
            } else {
                console.log('Not enough players to start the game:', gameId);
                socket.emit('error', 'Not enough players to start the game');
            }
        } else {
            console.log('Game not found or already started:', gameId);
            socket.emit('error', 'Game not found or already started');
        }
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        // Find and remove the player from any game they were in
        for (const [gameId, game] of games.entries()) {
            for (const team of ['red', 'blue']) {
                if (game.players[team].spymaster && game.players[team].spymaster.id === socket.id) {
                    game.players[team].spymaster = null;
                    io.to(gameId).emit('updatePlayerList', getPlayerList(game));
                    return;
                }
                const operativeIndex = game.players[team].operatives.findIndex(p => p.id === socket.id);
                if (operativeIndex !== -1) {
                    game.players[team].operatives.splice(operativeIndex, 1);
                    io.to(gameId).emit('updatePlayerList', getPlayerList(game));
                    return;
                }
            }
        }
    });
});

function canStartGame(game) {
    return game.players.red.spymaster && game.players.blue.spymaster &&
        game.players.red.operatives.length > 0 && game.players.blue.operatives.length > 0;
}

function getPlayerList(game) {
    return {
        red: {
            spymaster: game.players.red.spymaster,
            operatives: game.players.red.operatives
        },
        blue: {
            spymaster: game.players.blue.spymaster,
            operatives: game.players.blue.operatives
        }
    };
}

function getGameState(game, player) {
    return {
        board: game.board.map(card => ({
            word: card.word,
            color: (player && player.role === 'spymaster') ? card.color : (card.revealed ? card.color : null),
            revealed: card.revealed
        })),
        currentTurn: game.currentTurn,
        redCardsLeft: game.redCardsLeft,
        blueCardsLeft: game.blueCardsLeft,
        clue: game.clue,
        winner: game.winner,
        players: getPlayerList(game),
        started: game.started
    };
}

function getPlayerFromGame(game, playerId) {
    for (const team of ['red', 'blue']) {
        if (game.players[team].spymaster && game.players[team].spymaster.id === playerId) {
            return { ...game.players[team].spymaster, team, role: 'spymaster' };
        }
        const operative = game.players[team].operatives.find(p => p.id === playerId);
        if (operative) {
            return { ...operative, team, role: 'operative' };
        }
    }
    return null;
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});