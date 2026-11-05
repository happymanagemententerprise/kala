# KALA · Arena Tactics

Browser based simultaneous turn arena game. The frontend is Vite and Three.js/WebGL. A Node.js WebSocket service handles room codes, presence, turn locks, host actions, and TV viewers. The same Node service serves the built frontend in production.

## Layout

```text
kala/
├── frontend/           # Vite app, HTML/CSS, Three.js game and room client
│   ├── index.html
│   ├── src/main.js
│   └── vite.config.js
├── backend/src/server.js  # HTTP, room API, WebSockets, room lifecycle
├── package.json
└── render.yaml
```

## Run locally

Use Node.js 20.19 or newer:

```sh
npm install
npm run dev
```

Open `http://localhost:5173`. Vite proxies room API and WebSocket traffic to the Node room server on port 8787.

## Render deployment

This repo includes [render.yaml](render.yaml) for one Render **Web Service**. Render runs:

- Build command: `npm install && npm run build`
- Start command: `npm start`
- Health check: `/healthz`

The server binds to Render's `PORT`, serves `frontend/dist`, and accepts WebSockets on the same origin. Render supports inbound WebSockets on Web Services. [Render WebSocket docs](https://render.com/docs/websocket) · [Render deployment settings](https://render.com/docs/your-first-deploy)

Room records are held in memory. Run a single Render instance for now; restarts or multiple instances can lose or split active rooms. For durable, multi-instance rooms, add a shared store and coordination layer.

## Play and room controls

- Tap inside the arena to choose a position; drag to aim. Player moves stay hidden until all living operatives lock.
- Create a room and share its five-character code or invite link. Guests can join by code; the room lobby can also show a QR code that opens the read-only TV view on another device.
- Host controls include host transfer, kick, end game, back to lobby, and end room. Players can leave; the room host transfers when needed.
- Use a separate device/browser in TV view for a read-only room display.
- Standard shots stop at the first wall or obstacle. Three kills unlock one-bounce Ricochet. Only laser hits eliminate; arena shrink safely moves players inside.
- Solo and Teams bot matches continue after the human is eliminated.

The ray solver uses ray/segment intersections, polygon boundary tests, point-to-segment hit testing, and vector reflection.
