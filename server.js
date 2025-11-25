const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Store all games
const games = new Map();

// Card utilities
const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const VALUES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const value of VALUES) {
            deck.push({ suit, value, id: `${value}-${suit}` });
        }
    }
    // Add single Joker
    deck.push({ suit: 'joker', value: 'JOKER', id: 'joker' });
    return deck;
}

function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

function removePairs(cards) {
    const valueGroups = {};
    
    // Group cards by value
    for (const card of cards) {
        if (card.suit === 'joker') continue;
        if (!valueGroups[card.value]) {
            valueGroups[card.value] = [];
        }
        valueGroups[card.value].push(card);
    }
    
    const remaining = [];
    const discarded = [];
    
    // Keep one of each pair, discard pairs
    for (const value in valueGroups) {
        const group = valueGroups[value];
        while (group.length >= 2) {
            discarded.push(group.pop());
            discarded.push(group.pop());
        }
        remaining.push(...group);
    }
    
    // Add joker back
    const joker = cards.find(c => c.suit === 'joker');
    if (joker) remaining.push(joker);
    
    return { remaining, discarded };
}

function getCardColor(suit) {
    return suit === 'hearts' || suit === 'diamonds' ? 'red' : 'black';
}

// API Routes
app.get('/api/create-game', (req, res) => {
    const gameId = uuidv4().substring(0, 8);
    const hostId = uuidv4();
    
    games.set(gameId, {
        id: gameId,
        hostId: hostId,
        players: [],
        started: false,
        currentTurn: 0,
        direction: 1,
        deck: [],
        discardPile: [],
        finishedPlayers: [],
        winner: null,
        loser: null
    });
    
    res.json({ gameId, hostId });
});

app.get('/api/game/:gameId', (req, res) => {
    const game = games.get(req.params.gameId);
    if (!game) {
        return res.status(404).json({ error: 'Game not found' });
    }
    res.json({
        id: game.id,
        playerCount: game.players.length,
        started: game.started,
        players: game.players.map(p => ({ id: p.id, name: p.name, cardCount: p.cards.length, finished: p.finished }))
    });
});

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);
    
    let currentGame = null;
    let currentPlayer = null;
    
    socket.on('join-game', ({ gameId, playerId, playerName }) => {
        const game = games.get(gameId);
        if (!game) {
            socket.emit('error', { message: 'Game not found' });
            return;
        }
        
        if (game.started) {
            // Check if this is a reconnection
            const existingPlayer = game.players.find(p => p.id === playerId);
            if (existingPlayer) {
                existingPlayer.socketId = socket.id;
                existingPlayer.connected = true;
                socket.join(gameId);
                currentGame = game;
                currentPlayer = existingPlayer;
                
                emitGameState(game);
                return;
            }
            socket.emit('error', { message: 'Game already started' });
            return;
        }
        
        // Check if player already exists
        let player = game.players.find(p => p.id === playerId);
        
        if (!player) {
            if (game.players.length >= 20) {
                socket.emit('error', { message: 'Game is full (max 20 players)' });
                return;
            }
            
            player = {
                id: playerId,
                socketId: socket.id,
                name: playerName || `Player ${game.players.length + 1}`,
                cards: [],
                finished: false,
                connected: true
            };
            game.players.push(player);
        } else {
            player.socketId = socket.id;
            player.connected = true;
            player.name = playerName || player.name;
        }
        
        socket.join(gameId);
        currentGame = game;
        currentPlayer = player;
        
        emitGameState(game);
    });
    
    socket.on('start-game', ({ gameId, hostId }) => {
        const game = games.get(gameId);
        if (!game) return;
        
        if (game.hostId !== hostId) {
            socket.emit('error', { message: 'Only the host can start the game' });
            return;
        }
        
        if (game.players.length < 2) {
            socket.emit('error', { message: 'Need at least 2 players to start' });
            return;
        }
        
        // Initialize game
        game.started = true;
        game.deck = shuffleDeck(createDeck());
        
        // Distribute cards
        let cardIndex = 0;
        while (cardIndex < game.deck.length) {
            for (const player of game.players) {
                if (cardIndex < game.deck.length) {
                    player.cards.push(game.deck[cardIndex]);
                    cardIndex++;
                }
            }
        }
        
        // Remove initial pairs for each player
        for (const player of game.players) {
            const { remaining, discarded } = removePairs(player.cards);
            player.cards = remaining;
            game.discardPile.push(...discarded);
        }
        
        // Check if any players finished already
        checkFinishedPlayers(game);
        
        // Set first turn (find first player with cards)
        game.currentTurn = 0;
        while (game.players[game.currentTurn].finished && game.currentTurn < game.players.length - 1) {
            game.currentTurn++;
        }
        
        emitGameState(game);
    });
    
    socket.on('draw-card', ({ gameId, playerId, cardIndex }) => {
        const game = games.get(gameId);
        if (!game || !game.started) return;
        
        const player = game.players.find(p => p.id === playerId);
        if (!player) return;
        
        // Check if it's this player's turn
        if (game.players[game.currentTurn].id !== playerId) {
            socket.emit('error', { message: "It's not your turn!" });
            return;
        }
        
        // Find the next player with cards (to the right)
        let targetIndex = (game.currentTurn + 1) % game.players.length;
        while (game.players[targetIndex].finished) {
            targetIndex = (targetIndex + 1) % game.players.length;
        }
        
        const targetPlayer = game.players[targetIndex];
        
        if (cardIndex < 0 || cardIndex >= targetPlayer.cards.length) {
            socket.emit('error', { message: 'Invalid card selection' });
            return;
        }
        
        // Draw the card
        const drawnCard = targetPlayer.cards.splice(cardIndex, 1)[0];
        player.cards.push(drawnCard);
        
        // Check for pairs
        const { remaining, discarded } = removePairs(player.cards);
        player.cards = remaining;
        game.discardPile.push(...discarded);
        
        // Check if players finished
        checkFinishedPlayers(game);
        
        // Move to next turn
        if (!game.loser) {
            nextTurn(game);
        }
        
        emitGameState(game);
    });
    
    socket.on('disconnect', () => {
        console.log('Player disconnected:', socket.id);
        if (currentGame && currentPlayer) {
            currentPlayer.connected = false;
            emitGameState(currentGame);
        }
    });
    
    function checkFinishedPlayers(game) {
        let playersWithCards = 0;
        let lastPlayerWithCards = null;
        
        for (const player of game.players) {
            if (player.cards.length === 0 && !player.finished) {
                player.finished = true;
                game.finishedPlayers.push(player.id);
            }
            if (player.cards.length > 0) {
                playersWithCards++;
                lastPlayerWithCards = player;
            }
        }
        
        // Game ends when only one player has cards (the joker)
        if (playersWithCards === 1) {
            game.loser = lastPlayerWithCards.id;
            game.winner = game.finishedPlayers[0]; // First to finish wins
        }
    }
    
    function nextTurn(game) {
        let attempts = 0;
        do {
            game.currentTurn = (game.currentTurn + 1) % game.players.length;
            attempts++;
        } while (game.players[game.currentTurn].finished && attempts < game.players.length);
        
        // Check if next player also has cards to draw from
        let targetIndex = (game.currentTurn + 1) % game.players.length;
        let targetAttempts = 0;
        while (game.players[targetIndex].finished && targetAttempts < game.players.length) {
            targetIndex = (targetIndex + 1) % game.players.length;
            targetAttempts++;
        }
    }
    
    function emitGameState(game) {
        // Send personalized state to each player
        for (const player of game.players) {
            const socket = io.sockets.sockets.get(player.socketId);
            if (socket) {
                // Find target player (to draw from)
                let targetIndex = -1;
                if (game.started && !game.loser) {
                    targetIndex = (game.currentTurn + 1) % game.players.length;
                    while (game.players[targetIndex].finished) {
                        targetIndex = (targetIndex + 1) % game.players.length;
                    }
                }
                
                const state = {
                    gameId: game.id,
                    started: game.started,
                    currentTurn: game.currentTurn,
                    currentPlayerId: game.players[game.currentTurn]?.id,
                    targetPlayerId: targetIndex >= 0 ? game.players[targetIndex]?.id : null,
                    targetCardCount: targetIndex >= 0 ? game.players[targetIndex]?.cards.length : 0,
                    isMyTurn: game.players[game.currentTurn]?.id === player.id,
                    myCards: player.cards,
                    myId: player.id,
                    players: game.players.map(p => ({
                        id: p.id,
                        name: p.name,
                        cardCount: p.cards.length,
                        finished: p.finished,
                        connected: p.connected,
                        isMe: p.id === player.id
                    })),
                    finishedPlayers: game.finishedPlayers,
                    discardPileCount: game.discardPile.length,
                    winner: game.winner,
                    loser: game.loser,
                    hostId: game.hostId
                };
                
                socket.emit('game-state', state);
            }
        }
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`Donkey game server running on port ${PORT}`);
});
