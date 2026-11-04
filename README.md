# KALA · Neon Arena Tactics

Browser based, simultaneous turn tactics game. Three.js/WebGL renders the arena. Player rooms are coordinated by a Cloudflare Worker and one SQLite backed Durable Object per five character room code.

## Project layout

```text
kala/
├── frontend/          # Vite app: HTML, UI, Three.js game and room client
│   ├── index.html
│   ├── src/main.js
│   └── vite.config.js
└── backend/            # Cloudflare Worker and Durable Object room server
    ├── src/worker.js
    └── wrangler.toml
```

## Local development

Use Node.js 20.19 or newer. From the project root:

```sh
npm install
npm run dev
```

Vite serves the frontend on port 5173 and proxies room HTTP/WebSocket requests to Wrangler on port 8787. Wrangler runs the Durable Object locally, so room creation, joining, hidden move locks and TV view work without a separate Node room server.

## Deploy to Cloudflare

Authenticate Wrangler once, then build the frontend and deploy the Worker with its static assets:

```sh
npx wrangler login
npm run deploy
```

The Worker serves the built `frontend/dist` files and routes `/api/rooms` and `/ws/:code` through the Durable Object binding. The binding and SQLite Durable Object export are in [backend/wrangler.toml](backend/wrangler.toml). Durable Objects provide a single coordination point for each room and persist state through hibernation. The frontend and room socket use one origin, including TV links opened with `?tv=CODE`.

## Play

- Tap/click inside the safe zone to choose a position. Drag to set aim. Your move remains hidden on the shared display.
- Lock your move. Room players' moves stay private until every living operative commits; the volley is then shown together.
- Standard shots stop at the first wall or obstacle. Three eliminations unlock a single-bounce ricochet.
- Only laser hits eliminate. The arena reshapes and contracts between volleys; players outside the new boundary are repositioned safely.
- Solo and Teams modes support bot matches. Room matches support up to six players. If you are eliminated, you can watch the room continue.
- Create a room and share its code or invite link. The host starts the match. Open the TV view in a separate browser/device with the room code or `?tv=CODE`.
- Room controls include ready-up, host transfer, kick, leave, end match, return the room to the lobby, and close the room for everyone. Host actions are checked in the Durable Object; the host can manage the roster from the top-bar room shortcut.

The ray solver uses ray/segment intersections, point-in-polygon checks, point-to-segment hit testing and vector reflection.
