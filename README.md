# Donkey Card Game 🃏

A multiplayer online card game (also known as Old Maid / Le Pouilleux).

## Rules
- Cards are dealt to all players along with 1 Joker
- Each player discards their pairs
- Players take turns drawing a card from the player on their right
- When a pair is formed, it's discarded
- A player with no cards left has finished and watches the rest
- The loser is the one stuck with the Joker!

## Local Development

```bash
npm install
npm start
```

Then open http://localhost:3000

## Deployment

This app is ready to deploy on Render, Railway, or any Node.js hosting platform.

### Environment Variables
- `PORT` - Server port (automatically set by hosting platforms)

## Tech Stack
- Node.js + Express
- Socket.io for real-time communication
- Vanilla JavaScript frontend
