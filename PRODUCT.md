# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Players on desktop and mobile who want quick tactical elimination matches, plus hosts who manage rooms and TV viewers who follow matches on a shared screen.

## Product Purpose

Kala is a simultaneous-move arena tactics game. Players secretly choose a position and a laser direction, then resolve all shots together. Success means players can understand the current phase, make a move confidently, and follow the match without revealing uncommitted positions.

## Positioning

Kala combines hidden simultaneous movement, directional laser shots, and a shrinking arena in a browser game that supports solo play, teams, private multiplayer rooms, and a read-only TV view.

## Operating Context

Most play is on phones (about 95%), using touch controls; desktop and shared TV screens are also supported. Room hosts create and manage rooms, guests join with a short code or invite link, and a separate TV device can watch a room. The TV view must not expose positions or aim lines before all players have locked their moves.

## Capabilities and Constraints

- Solo free-for-all and team matches, with bots continuing after the human player is eliminated.
- Room creation and joining by code, host transfer, player removal, return to lobby, end match, and end room.
- Read-only TV view with QR and link sharing.
- During placement, each player sees only their own position marker; all players' positions and shots are revealed together only after every living player has locked and the volley resolves. TV viewers see no positions before that reveal.
- Standard and one-bounce reflective laser shots, obstacles, simultaneous resolution, and safe arena shrinking. Only laser strikes eliminate players.
- Responsive HTML5 interface using Three.js/WebGL and a Node.js WebSocket service deployed on Render.
- Keep game rules, room actions, URLs, and hidden-move behavior intact during visual redesign.

## Brand Commitments

- Product name: Kala.
- User-provided palette for this redesign: Frosted Mint `#e6fbda`, Lemon Chiffon `#fff8d3`, Moss Green `#85d176`, Dusk Blue `#3f5ba4`, and Deep Space Blue `#0d2d46`.

## Evidence on Hand

The repository contains a working game UI, game mechanics, room controls, TV view, and responsive styles. Do not invent endorsements, player counts beyond the implementation limits, or claims about deployed service availability.

## Product Principles

- Keep player choices private until the volley is committed.
- Make the current match phase and the next useful action easy to understand.
- Keep room and spectator controls usable on phones and shared screens.
- Arena shrinkage never eliminates a player; laser strikes do.
