import * as THREE from 'three';
import QRCode from 'qrcode';

// Kala keeps the authoritative board and all pending moves local. Nothing is
// drawn from a pending move until every living operative has committed.
const $ = (s) => document.querySelector(s);
const arenaRoot = $('#arena-root');
const palette = { mint: 0xe6fbda, moss: 0x85d176, dusk: 0x3f5ba4, deep: 0x0d2d46, lemon: 0xfff8d3, red: 0xb95f58, white: 0xe6fbda };
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, .1, 100);
camera.position.set(0, 0, 32);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.setSize(arenaRoot.clientWidth, arenaRoot.clientHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.22;
arenaRoot.appendChild(renderer.domElement);

const group = new THREE.Group(); scene.add(group);
const v = (x, y) => new THREE.Vector2(x, y);
const len = (a) => Math.hypot(a.x, a.y);
const norm = (a) => { const l = len(a) || 1; return v(a.x / l, a.y / l); };
const add = (a, b) => v(a.x + b.x, a.y + b.y);
const sub = (a, b) => v(a.x - b.x, a.y - b.y);
const mul = (a, s) => v(a.x * s, a.y * s);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const dist = (a, b) => len(sub(a, b));
const mix = (a, b, t) => add(mul(a, 1 - t), mul(b, t));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const TAU = Math.PI * 2;
let view = { w: 20, h: 20, radius: 7.4 };
let randomSource = Math.random;
const ambientUniforms = { uTime: { value: 0 } };
const ambient = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShaderMaterial({
  uniforms: ambientUniforms,
  vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `varying vec2 vUv; uniform float uTime;
    float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
    void main(){ vec2 uv=vUv; vec2 p=(uv-.5)*vec2(1.0,1.15); float vignette=1.0-smoothstep(.12,.72,length(p));
      float grid=max(step(.992,fract(uv.x*64.0)),step(.992,fract(uv.y*64.0))); float drift=.5+.5*sin(uTime*.12+uv.x*5.0+uv.y*3.0);
      float grain=hash(floor(uv*vec2(270.0,170.0))+floor(uTime*3.0)); vec3 base=vec3(.051,.176,.275)+vec3(.04,.10,.12)*vignette*(.65+.35*drift);
      base+=vec3(.13,.21,.45)*grid*vignette*.10; base+=vec3(.45,.63,.52)*step(.999,grain)*.08; gl_FragColor=vec4(base,1.0); }`
}));
ambient.position.z = -8; scene.add(ambient);

const state = {
  round: 1, mode: 'ffa', botCount: 3, zone: 1, active: true, phase: 'planning',
  selected: null, aim: 0, locked: false, lockedMoves: new Map(), beams: [], particles: [], plannedToken: null,
  showBeamsUntil: 0, toastTimeout: null, pendingRound: null, sound: true,
  players: [], arena: [], obstacles: [], human: null, lastResult: null,
  online: false, tv: false, roomSocket: null, roomCode: null, roomRole: null, roomPhase: null, roomPlayers: [], clientId: null, roomHostId: null, roomSeed: 1, boundaryPulse: null,
};
let startupTV = new URLSearchParams(location.search).has('tv');

const colorOf = (p) => p.human ? palette.mint : state.mode === 'teams' ? (p.team === 'Red' ? palette.red : palette.dusk) : p.color;
const names = ['VEX', 'GHOST', 'NYX', 'ROOK', 'ECHO', 'ZERO', 'KITE'];
const botColors = [palette.red, palette.dusk, palette.lemon, palette.moss, 0xf0c9a6, 0x8da8cf];
const random = (a, b) => a + randomSource() * (b - a);

function makePolygon(sides, radius, rotation = -Math.PI / 2, center = v(0, 0)) {
  return Array.from({ length: sides }, (_, i) => {
    const angle = rotation + i * TAU / sides;
    return add(center, v(Math.cos(angle) * radius, Math.sin(angle) * radius));
  });
}
function polygonArea(poly) {
  return poly.reduce((sum, p, i) => sum + cross(p, poly[(i + 1) % poly.length]), 0) / 2;
}
function pointInPolygon(point, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function closestOnSegment(p, a, b) {
  const ab = sub(b, a), d = dot(ab, ab);
  return add(a, mul(ab, d ? clamp(dot(sub(p, a), ab) / d, 0, 1) : 0));
}
function pointSegmentDistance(p, a, b) { return dist(p, closestOnSegment(p, a, b)); }
function raySegment(origin, direction, a, b, epsilon = 1e-7) {
  const edge = sub(b, a), denom = cross(direction, edge);
  if (Math.abs(denom) < epsilon) return null;
  const delta = sub(a, origin), t = cross(delta, edge) / denom, u = cross(delta, direction) / denom;
  if (t > epsilon && u >= -epsilon && u <= 1 + epsilon) return { t, point: add(origin, mul(direction, t)), edge, a, b };
  return null;
}
function reflect(direction, edge) {
  // Reflection is invariant to normal sign: r = d - 2(d·n)n.
  const normal = norm(v(-edge.y, edge.x));
  return norm(sub(direction, mul(normal, 2 * dot(direction, normal))));
}
function nearestBoundary(origin, direction) {
  let best = null;
  const polygons = [state.arena, ...state.obstacles.map(o => o.points)];
  for (let pi = 0; pi < polygons.length; pi++) {
    const poly = polygons[pi];
    for (let i = 0; i < poly.length; i++) {
      const hit = raySegment(origin, direction, poly[i], poly[(i + 1) % poly.length]);
      if (hit && (!best || hit.t < best.t)) best = { ...hit, obstacle: pi > 0 };
    }
  }
  return best;
}
function clampInsideArena(point) {
  if (pointInPolygon(point, state.arena) && !state.obstacles.some(o => pointInPolygon(point, o.points))) return point;
  let best = null, bestD = Infinity;
  for (let i = 0; i < state.arena.length; i++) {
    const a = state.arena[i], b = state.arena[(i + 1) % state.arena.length];
    const candidate = mix(closestOnSegment(point, a, b), v(0, 0), 0.018);
    const d = dist(point, candidate);
    if (pointInPolygon(candidate, state.arena) && d < bestD) { best = candidate; bestD = d; }
  }
  if (!best) best = v(0, 0);
  for (const obstacle of state.obstacles) {
    if (pointInPolygon(best, obstacle.points)) {
      const outward = norm(best);
      best = add(best, mul(outward, .8));
    }
  }
  return pointInPolygon(best, state.arena) ? best : v(0, 0);
}
function safeStart(angle, radius) {
  let p = v(Math.cos(angle) * radius, Math.sin(angle) * radius);
  for (let tries = 0; tries < 24 && state.obstacles.some(o => pointInPolygon(p, o.points)); tries++) {
    angle += .19; p = v(Math.cos(angle) * radius, Math.sin(angle) * radius);
  }
  return clampInsideArena(p);
}

function setLine(line, color, opacity = 1, width = 1) {
  const old = line.parent ? line.material : null;
  if (old) { if (Array.isArray(old)) old.forEach(m => m.dispose()); else old.dispose(); }
  line.material = new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false, linewidth: width });
}
function makeLine(points, color, opacity = 1, width = 1, closed = false) {
  const verts = points.map(p => new THREE.Vector3(p.x, p.y, 0));
  if (closed && points.length) verts.push(verts[0].clone());
  const obj = new THREE.Line(new THREE.BufferGeometry().setFromPoints(verts), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false, linewidth: width }));
  group.add(obj); return obj;
}
function circleMesh(radius, color, opacity = 1, z = .2) {
  const obj = new THREE.Mesh(new THREE.CircleGeometry(radius, 32), new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, blending: THREE.AdditiveBlending, depthWrite: false }));
  obj.position.z = z; return obj;
}

function buildArena() {
  const sides = [9, 7, 8, 6, 10, 7, 8][(state.round - 1) % 7];
  const amount = state.round === 1 ? 1 : clamp(1 - (state.round - 1) * .047, .55, .96);
  state.zone = amount;
  const availableRadius = Math.max(3.2, Math.min(view.w * .44, view.h * .39));
  const radius = (state.online ? 7.4 : availableRadius) * amount;
  state.arena = makePolygon(sides, radius, -Math.PI / 2 + (state.round % 2) * .12);
  state.obstacles = [];
  const count = Math.min(4, 2 + Math.floor(state.round / 3));
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * TAU + state.round * .51;
    const cx = Math.cos(angle) * radius * .34, cy = Math.sin(angle) * radius * .34;
    const width = radius * random(.15, .22), height = radius * random(.08, .13);
    const rot = angle + Math.PI / 2 + random(-.4, .4), c = Math.cos(rot), s = Math.sin(rot);
    const pts = [[-width/2,-height/2],[width/2,-height/2],[width/2,height/2],[-width/2,height/2]].map(([x,y]) => v(cx+x*c-y*s,cy+x*s+y*c));
    state.obstacles.push({ points: pts });
  }
  for (const p of state.players) if (p.alive) p.pos = clampInsideArena(p.pos);
}

function makePlayers() {
  const n = state.botCount + 1;
  state.players = [{ id: 'human', name: 'YOU', human: true, alive: true, kills: 0, team: 'Blue', color: palette.mint, pos: v(0, 0), move: null }];
  for (let i = 1; i < n; i++) state.players.push({ id: `bot-${i}`, name: names[(i - 1) % names.length], human: false, alive: true, kills: 0, team: i % 2 ? 'Red' : 'Blue', color: botColors[(i - 1) % botColors.length], pos: v(0, 0), move: null });
  state.human = state.players[0];
  const startRadius = Math.min(view.w * .31, view.h * .29, view.radius * .65);
  state.players.forEach((p, i) => { p.pos = safeStart(-Math.PI / 2 + TAU * i / n, startRadius); });
}

function rebuildVisuals() {
  state.boundaryPulse = null;
  state.plannedToken = null;
  while (group.children.length) {
    const child = group.children.pop();
    if (child.geometry) child.geometry.dispose();
    if (child.material) { if (Array.isArray(child.material)) child.material.forEach(m => m.dispose()); else child.material.dispose(); }
  }
  const backdrop = makeLine(state.arena, palette.dusk, .18, 1, true);
  backdrop.position.z = .0;
  makeLine(state.arena, palette.moss, .88, 1, true).position.z = .08;
  const inner = state.arena.map(p => mul(p, .965));
  makeLine(inner, palette.mint, .25, 1, true).position.z = .07;
  state.arena.forEach((p, i) => {
    const marker = circleMesh(.05, palette.lemon, .85, .12); marker.position.set(p.x, p.y, .12); group.add(marker);
  });
  for (const obstacle of state.obstacles) {
    const shape = new THREE.Shape(); shape.moveTo(obstacle.points[0].x, obstacle.points[0].y);
    obstacle.points.slice(1).forEach(p => shape.lineTo(p.x, p.y)); shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: palette.dusk, transparent: true, opacity: .78, side: THREE.DoubleSide, depthWrite: false }));
    mesh.position.z = .16; group.add(mesh);
    makeLine(obstacle.points, palette.deep, .5, 1, true).position.z = .18;
    makeLine(obstacle.points, palette.mint, .8, 1, true).position.z = .19;
    obstacle.points.forEach(p => { const glint = circleMesh(.028, palette.lemon, .8, .2); glint.position.set(p.x,p.y,.2); group.add(glint); });
    const inset = obstacle.points.map(p => mix(p, v((obstacle.points[0].x+obstacle.points[2].x)/2,(obstacle.points[0].y+obstacle.points[2].y)/2), .12));
    makeLine(inset, palette.lemon, .45, 1, true).position.z = .19;
  }
  addAmbient();
  // Shared-screen mode deliberately suppresses every operative and aim marker
  // while moves are being chosen. The full board appears only after lock-in.
  if (state.phase === 'resolving' || state.phase === 'finished') {
    for (const p of state.players) if (p.alive) addToken(p);
  }
}
function addAmbient() {
  // Sparse drifting stellar noise; points are seeded once per board.
  const positions = [];
  for (let i = 0; i < 120; i++) {
    const x = random(-view.w * .49, view.w * .49), y = random(-view.h * .48, view.h * .48);
    if (!pointInPolygon(v(x, y), state.arena)) positions.push(x, y, -.2);
  }
  const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const stars = new THREE.Points(geo, new THREE.PointsMaterial({ color: palette.mint, size: .035, transparent: true, opacity: .22, sizeAttenuation: false, depthWrite: false })); group.add(stars);
}
function startBoundaryPulse() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const points = state.arena;
  if (points.length < 2) return;
  const lengths = points.map((point, i) => dist(point, points[(i + 1) % points.length]));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const glow = circleMesh(.34, palette.moss, .28, .36);
  const marker = circleMesh(.105, palette.lemon, .96, .38);
  group.add(glow, marker);
  state.boundaryPulse = { started: performance.now(), duration: 1250, points, lengths, total, glow, marker };
}
function updateBoundaryPulse(now) {
  const pulse = state.boundaryPulse;
  if (!pulse) return;
  const progress = (now - pulse.started) / pulse.duration;
  if (progress >= 1) {
    group.remove(pulse.glow, pulse.marker);
    pulse.glow.geometry.dispose(); pulse.glow.material.dispose();
    pulse.marker.geometry.dispose(); pulse.marker.material.dispose();
    state.boundaryPulse = null;
    return;
  }
  let distanceAlong = Math.max(0, progress) * pulse.total;
  let index = 0;
  while (index < pulse.lengths.length - 1 && distanceAlong > pulse.lengths[index]) distanceAlong -= pulse.lengths[index++];
  const segmentLength = pulse.lengths[index] || 1;
  const point = mix(pulse.points[index], pulse.points[(index + 1) % pulse.points.length], distanceAlong / segmentLength);
  pulse.marker.position.set(point.x, point.y, .38);
  pulse.glow.position.set(point.x, point.y, .36);
  const fade = Math.sin(Math.PI * Math.max(0, progress));
  pulse.glow.material.opacity = .13 + fade * .28;
  pulse.glow.scale.setScalar(.9 + fade * .45);
}
function addToken(player) {
  const color = colorOf(player), hex = `#${color.toString(16).padStart(6, '0')}`;
  const root = new THREE.Group(); root.position.set(player.pos.x, player.pos.y, .8); root.userData.playerId = player.id; player.visual = root; group.add(root);
  const halo = circleMesh(.57, color, .08, 0); root.add(halo);
  const outer = new THREE.Mesh(new THREE.RingGeometry(.39, .43, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .8, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); outer.position.z = .12; root.add(outer);
  const inner = new THREE.Mesh(new THREE.RingGeometry(.27, .29, 40), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: .6, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false })); inner.position.z = .12; root.add(inner);
  const core = new THREE.Mesh(new THREE.CircleGeometry(.22, 48), new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: ambientUniforms.uTime },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
    fragmentShader: 'varying vec2 vUv; uniform vec3 uColor; uniform float uTime; void main(){ vec2 p=vUv-.5; float r=length(p)*2.0; float rim=smoothstep(.51,.20,r); float pulse=.78+.22*sin(uTime*5.0); float alpha=(.17+rim*.68)*pulse; vec3 col=mix(uColor,vec3(1.0),pow(rim,4.0)*.64); gl_FragColor=vec4(col,alpha); }',
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
  })); core.position.z = .14; root.add(core);
  const center = circleMesh(.135, palette.deep, .97, .15); root.add(center);
  const pip = circleMesh(.042, palette.lemon, .95, .16); pip.position.set(-.045, .065, 0); root.add(pip);
  const label = makeTextSprite(player.human ? 'YOU' : player.name, player.human ? '#e6fbda' : `#${color.toString(16).padStart(6, '0')}`);
  label.position.set(0, -.7, .17); root.add(label);
  const directional = makeLine([v(0,.19),v(.12,.05),v(.035,.05),v(.035,-.08),v(-.035,-.08),v(-.035,.05),v(-.12,.05),v(0,.19)], palette.lemon, .75, 1, false);
  directional.scale.set(.27,.27,1); directional.position.set(0,0,.17); root.add(directional);
  player.visualParts = { halo, outer, inner, core };
  player.visual.color = hex;
}
function makeTextSprite(text, color) {
  const canvas = document.createElement('canvas'); canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d'); ctx.font = '600 28px "DM Mono", monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
  ctx.shadowColor = color; ctx.shadowBlur = 12; ctx.fillText(text, 128, 32);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  sprite.scale.set(1.22, .31, 1); return sprite;
}

function drawPlannedMove() {
  if (state.tv || !state.human?.human || !state.human.alive || state.phase !== 'planning' || !state.selected) {
    removePlanned();
    return;
  }
  if (state.plannedToken?.parent) {
    state.plannedToken.position.set(state.selected.x,state.selected.y,.8);
    return;
  }
  const preview={...state.human,pos:state.selected,visual:null,visualParts:null};
  addToken(preview);
  state.plannedToken=preview.visual;
  state.plannedToken.userData.planned=true;
}
function removePlanned() {
  for (let i = group.children.length - 1; i >= 0; i--) if (group.children[i].userData.planned) {
    const obj = group.children[i]; group.remove(obj); obj.geometry?.dispose(); obj.material?.dispose();
  }
  state.plannedToken=null;
}
function addBeamSegment(a, b, color, faint = false) {
  const c = new THREE.Color(color);
  const outer = makeLine([a,b], c, faint ? .18 : .24, 1); outer.position.z = .42;
  const mid = makeLine([a,b], c, faint ? .45 : .65, 1); mid.scale.set(1,1,1); mid.position.z = .44;
  const hot = makeLine([a,b], palette.lemon, faint ? .64 : .94, 1); hot.position.z = .46;
  state.beams.push({ objects: [outer,mid,hot], until: performance.now() + (faint ? 500 : 1500), color });
}

function getShotPath(origin, angle, bounce) {
  const path = []; let start = origin, dir = norm(v(Math.cos(angle), Math.sin(angle))), remaining = bounce ? 2 : 1;
  while (remaining-- > 0) {
    const hit = nearestBoundary(start, dir);
    const end = hit ? hit.point : add(start, mul(dir, 100));
    path.push({ a: start, b: end });
    if (!hit || remaining <= 0 || !bounce) break;
    dir = reflect(dir, hit.edge);
    start = add(hit.point, mul(dir, .012));
  }
  return path;
}
function botMove(bot, allMoves) {
  const alive = state.players.filter(p => p.alive && p !== bot);
  let target = null;
  if (state.mode === 'teams') target = alive.find(p => p.team !== bot.team) || null;
  else target = alive.reduce((best,p) => !best || p.kills > best.kills ? p : best, null);
  const base = bot.pos, oldTarget = target ? (allMoves.get(target.id)?.pos || target.pos) : v(0,0);
  const radial = Math.atan2(base.y,base.x), direction = Math.atan2(oldTarget.y-base.y,oldTarget.x-base.x);
  const rotate = (Math.random() < .5 ? -1 : 1) * random(.35,1.15);
  const candidateAngle = direction + rotate;
  let dest = clampInsideArena(v(Math.cos(candidateAngle)*Math.min(view.radius*.55,len(base)+random(.5,2.2)),Math.sin(candidateAngle)*Math.min(view.radius*.55,len(base)+random(.5,2.2))));
  if (state.obstacles.some(o => pointInPolygon(dest,o.points))) dest = safeStart(radial + random(-1.4,1.4), view.radius*.42);
  if (state.mode === 'teams' && target?.team === bot.team) target = alive.find(p => p.team !== bot.team) || target;
  if (!target) return { pos: dest, aim: direction, weapon: 'standard' };
  const aimAt = allMoves.get(target.id)?.pos || target.pos;
  const aim = Math.atan2(aimAt.y-dest.y, aimAt.x-dest.x) + random(-.14,.14);
  return { pos: dest, aim, weapon: bot.kills >= 3 && Math.random() < .42 ? 'ricochet' : 'standard' };
}
function planBots() {
  const moves = new Map();
  for (const p of state.players.filter(p => p.alive)) {
    if (p.human) continue;
    moves.set(p.id, botMove(p, moves));
  }
  // Re-aim each bot after all simultaneous destination choices are known.
  for (const p of state.players.filter(p => p.alive && !p.human)) {
    const move = moves.get(p.id), target = state.players.filter(q => q.alive && q !== p && (state.mode !== 'teams' || q.team !== p.team)).sort((a,b) => b.kills-a.kills)[0];
    if (target) { const t = moves.get(target.id)?.pos || target.pos; move.aim = Math.atan2(t.y-move.pos.y,t.x-move.pos.x)+random(-.18,.18); }
  }
  return moves;
}
function acquirePosition(p) {
  return state.lockedMoves.get(p.id)?.pos || p.pos;
}

function vibrateForOpponentHit() {
  if (typeof navigator.vibrate !== 'function') return;
  const hasTouch = navigator.maxTouchPoints > 0 || matchMedia('(pointer: coarse)').matches;
  if (!hasTouch) return;
  try { navigator.vibrate([90, 45, 150]); } catch { /* Haptics are optional on unsupported browsers. */ }
}

function resolveVolley(sharedMoves = null) {
  if (state.phase !== 'planning' && state.phase !== 'locked') return;
  const moves = state.online ? new Map(state.lockedMoves) : new Map(planBots());
  if (sharedMoves) {
    moves.clear();
    for (const [id, move] of Object.entries(sharedMoves)) moves.set(id, { pos: v(move.pos.x, move.pos.y), aim: move.aim, weapon: move.weapon });
  }
  const humanMove = state.lockedMoves.get('human');
  if (state.human?.alive && humanMove) moves.set(state.human.id || 'human', humanMove);
  for (const p of state.players) if (p.alive && !moves.has(p.id)) moves.set(p.id, { pos:p.pos, aim:0, weapon:'standard' });
  // All positions are committed before any beam or elimination is evaluated.
  const paths = [];
  for (const p of state.players.filter(p => p.alive)) {
    const move = moves.get(p.id); move.pos = clampInsideArena(move.pos); p.pos = move.pos;
    if (p.visual) p.visual.position.set(p.pos.x,p.pos.y,.8);
    for (const segment of getShotPath(move.pos, move.aim, move.weapon === 'ricochet' && p.kills >= 3)) paths.push({ shooter:p, move, segment });
  }
  const killed = new Map();
  for (const { shooter, move, segment } of paths) {
    const limit = dist(segment.a,segment.b);
    if (limit < .02) continue;
    for (const target of state.players.filter(p => p.alive)) {
      if (target === shooter) continue;
      const hitDist = pointSegmentDistance(target.pos, segment.a, segment.b);
      const projection = dot(sub(target.pos,segment.a), norm(sub(segment.b,segment.a)));
      if (hitDist <= .29 && projection >= -.04 && projection <= limit + .04) {
        if (!killed.has(target.id)) killed.set(target.id, new Set());
        killed.get(target.id).add(shooter.id);
      }
    }
  }
  state.beams = [];
  for (const { shooter, segment } of paths) addBeamSegment(segment.a, segment.b, colorOf(shooter));
  const humanId=state.human?.id||'human';
  const humanHit = Boolean(state.human?.alive && killed.has(humanId));
  const attackerIds=killed.get(humanId)||new Set();
  const hitByOpponent=[...attackerIds].some(id=>{
    const attacker=state.players.find(player=>player.id===id);
    return attacker&&attacker!==state.human&&(state.mode!=='teams'||attacker.team!==state.human.team);
  });
  for (const [id, shooters] of killed) {
    const target = state.players.find(p=>p.id===id); if (!target?.alive) continue;
    target.alive = false; target.move = null;
    for (const sid of shooters) { const shooter=state.players.find(p=>p.id===sid); if (shooter) shooter.kills++; }
    burst(target.pos,colorOf(target));
  }
  if (hitByOpponent) vibrateForOpponentHit();
  state.lastResult = { killed, humanHit, hitByOpponent };
  state.phase = 'resolving'; state.showBeamsUntil = performance.now()+1500;
  for (const p of state.players) {
    if (p.alive) addToken(p);
    else if (p.visual) { group.remove(p.visual); p.visual = null; }
  }
  if (state.human?.alive && state.human.visual) { state.human.visual.position.set(state.human.pos.x,state.human.pos.y,.8); }
  startBoundaryPulse();
  state.locked = false; state.selected = null; state.lockedMoves.clear();
  updateHUD();
  const ended = checkWinner();
  if (ended) state.phase = 'finished';
  $('#arena-title').textContent = humanHit ? 'You were eliminated.' : killed.size ? `${killed.size} operative${killed.size===1?'':'s'} down.` : 'Clean round. For now.';
  $('#control-title').textContent = humanHit ? 'SPECTATOR MODE' : 'VOLLEY RESOLVED';
  $('#control-description').textContent = humanHit ? 'Watch the remaining operatives fight for the arena.' : 'The arena will contract and reshape before the next volley.';
  $('#fire-label').textContent = state.online ? (ended ? 'MATCH COMPLETE' : 'ROUND RESOLVED') : ended ? 'NEW MATCH' : 'NEXT ROUND';
  $('#fire-button').disabled = state.online;
  $('#undo-button').disabled = true;
  $('#hint-label').textContent = 'VOLLEY RESOLVED · ARENA RESHAPING';
  showBanner(ended ? 'MATCH OVER' : 'VOLLEY', ended ? winnerTitle() : 'CLEAR', ended ? winnerTitle() : `${killed.size ? killed.size+' operative'+(killed.size===1?'':'s')+' eliminated' : 'No eliminations'} · NEXT ROUND IN 2 SEC`);
  if (state.online && !state.tv && state.clientId === state.roomHostId) {
    sendRoom({ type: 'round-resolution', players: state.players.map(p => ({ id:p.id, alive:p.alive, kills:p.kills, pos:{x:p.pos.x,y:p.pos.y} })) });
  }
  if (state.pendingRoomResult) { const result=state.pendingRoomResult;state.pendingRoomResult=null;applyRoomResult(result); }
  if (!ended && !state.online) state.pendingRound = setTimeout(nextRound, 1900);
  playShotSound(paths.length);
}

function checkWinner() {
  const alive=state.players.filter(p=>p.alive);
  if (state.mode==='teams') return new Set(alive.map(p=>p.team)).size<=1;
  return alive.length<=1;
}
function winnerTitle() {
  const alive=state.players.filter(p=>p.alive);
  if (!alive.length) return 'DRAW';
  const winner=alive[0]; return winner.human?'YOU SURVIVED':`${winner.name} WINS`;
}
function nextRound() {
  if (state.online) return;
  if (!state.active || state.phase==='finished') return;
  state.pendingRound=null;
  if (checkWinner()) { state.phase='finished'; showBanner('MATCH OVER',winnerTitle(),'START A NEW MATCH TO PLAY AGAIN'); $('#fire-label').textContent='NEW MATCH'; $('#fire-button').disabled=false; return; }
  state.round++;
  for (const p of state.players) { p.move=null; if(p.alive) p.pos=clampInsideArena(p.pos); }
  buildArena();
  state.phase='planning'; state.locked=false; state.selected=state.human.alive?state.human.pos:null; state.aim=0; state.lockedMoves.clear();
  rebuildVisuals();
  setPlanningUI();
  $('#arena-title').textContent=state.human.alive?'Set your position.':'Bots are taking their positions.';
  showBanner(`ROUND ${String(state.round).padStart(2,'0')}`,'DEPLOY','New zone configuration · choose your position');
  updateHUD();
  if (state.human.alive) drawPlannedMove(); else { $('#fire-button').disabled=true; setTimeout(()=>{if(state.phase==='planning')resolveVolley();},750); }
}

function burst(pos,color) {
  const count=56, coords=[], velocities=[];
  for(let i=0;i<count;i++){ const a=Math.random()*TAU, speed=random(.4,3.3); coords.push(pos.x,pos.y,.95); velocities.push(Math.cos(a)*speed,Math.sin(a)*speed,random(-.15,.4)); }
  const geometry=new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.Float32BufferAttribute(coords,3));
  const points=new THREE.Points(geometry,new THREE.ShaderMaterial({
    uniforms:{uColor:{value:new THREE.Color(color)},uOpacity:{value:1}},
    vertexShader:'varying float vAlpha; uniform float uOpacity; void main(){ vec4 mvPosition=modelViewMatrix*vec4(position,1.0); gl_Position=projectionMatrix*mvPosition; gl_PointSize=clamp(5.5*(18.0/-mvPosition.z),1.0,12.0); vAlpha=uOpacity; }',
    fragmentShader:'varying float vAlpha; uniform vec3 uColor; void main(){ float r=length(gl_PointCoord-.5); float a=(1.0-smoothstep(.12,.5,r))*vAlpha; gl_FragColor=vec4(mix(uColor,vec3(1.0),.38),a); }',
    transparent:true,blending:THREE.AdditiveBlending,depthWrite:false,
  }));group.add(points);
  state.particles.push({object:points,velocity:velocities,start:performance.now(),life:850,origin:pos});
  const flash=circleMesh(.62,color,.55,1);flash.position.set(pos.x,pos.y,1);group.add(flash);
  state.particles.push({object:flash,start:performance.now(),life:370,flash:true,base:.62});
}

function newMatch() {
  if(state.pendingRound)clearTimeout(state.pendingRound);
  state.online=false;state.tv=false;state.roomRole=null;
  document.body.classList.toggle('tv-view',startupTV);startupTV=false;randomSource=Math.random;
  $('#new-match').disabled=false;
  $('#room-open').textContent='＋  CREATE A ROOM';
  const cleanUrl=new URL(location.href);cleanUrl.searchParams.delete('tv');cleanUrl.searchParams.delete('room');history.replaceState({},'',cleanUrl);
  state.round=1;state.zone=1;state.phase='planning';state.locked=false;state.selected=null;state.aim=0;state.lockedMoves.clear();state.beams=[];state.particles=[];state.lastResult=null;state.pendingRoomResult=null;
  buildArena();makePlayers();state.selected=state.human.pos;rebuildVisuals();setPlanningUI();updateHUD();drawPlannedMove();
  $('#arena-title').textContent='Set your position.';$('#arena-kicker').textContent='SECTOR 07 · LIVE FEED';$('#sector-label').textContent=`SECTOR ${String(7+(state.round%9)).padStart(2,'0')} / MINTFIELD ARENA`;
  showBanner('ROUND 01','DEPLOY','Choose your position and lock your shot');
}
function setPlanningUI() {
  $('#phase-label').textContent=state.phase==='finished'?'MATCH COMPLETE':state.human.alive?'OPERATIVE INPUT REQUIRED':'SPECTATOR MODE';
  $('#control-title').textContent=state.human.alive?'DEPLOY YOUR OPERATIVE':'SPECTATOR MODE';
  $('#control-description').textContent=state.human.alive?'Choose a safe position. Your move stays hidden until every shot is locked.':'Bots continue playing automatically until a winner is determined.';
  $('#fire-label').textContent=state.human.alive?'LOCK POSITION':'OBSERVE';
  $('#fire-button').disabled=!state.human.alive;
  $('#undo-button').disabled=false;
  $('#hint-label').textContent=state.human.alive?'TAP ARENA TO POSITION · DRAG TO AIM':'BOTS ARE PLANNING · POSITIONS HIDDEN';
}
function updateHUD() {
  $('#round-number').textContent=String(state.round).padStart(2,'0');$('#round-total').textContent='12';
  $('#round-progress').style.width=`${Math.min(100,state.round/12*100)}%`;
  $('#zone-readout').textContent=`${Math.round(state.zone*100)}%`;
  $('#kill-readout').textContent=String(state.human?.kills||0).padStart(2,'0');
  const alive=state.players.filter(p=>p.alive).length;$('#alive-count').textContent=`${String(alive).padStart(2,'0')} ACTIVE`;
  const committed=state.locked?state.players.filter(p=>p.alive).length:0;$('#players-ready').textContent=`${committed} / ${state.players.filter(p=>p.alive).length} LOCKED`;
  const roster=$('#roster');roster.innerHTML='';
  for(const p of state.players){
    const row=document.createElement('div');row.className=`roster-row${p.human?' current':''}${p.alive?'':' dead'}`;
    const avatar=document.createElement('span');avatar.className='roster-avatar';avatar.textContent=p.human?'K':p.name[0];avatar.style.borderColor=p.alive?`#${colorOf(p).toString(16).padStart(6,'0')}`:'';avatar.style.color=p.alive?`#${colorOf(p).toString(16).padStart(6,'0')}`:'';
    const meta=document.createElement('span');meta.className='roster-meta';const title=document.createElement('strong');title.textContent=p.human?'YOU':p.name;const subtitle=document.createElement('small');subtitle.textContent=`${p.human?'OPERATIVE':state.mode==='teams'?p.team.toUpperCase()+' TEAM':'HOSTILE'} · ${p.alive?'ACTIVE':'ELIMINATED'}`;meta.append(title,subtitle);
    const stats=document.createElement('span');stats.className=p.alive?'roster-kills':'dead-mark';stats.textContent=p.alive?`${String(p.kills).padStart(2,'0')} ✦`:'×';row.append(avatar,meta,stats);roster.appendChild(row);
  }
  const bounce=$('#ricochet-button'),copy=$('#ricochet-copy');
  if(state.human?.kills>=3){bounce.classList.remove('locked');copy.textContent='UNLOCKED · ONE REFLECTION';if(state.humanWeapon==='ricochet')bounce.classList.add('selected');}
  else{bounce.classList.add('locked');copy.textContent=`LOCKED · ${Math.max(0,3-(state.human?.kills||0))} MORE ELIMINATION${3-(state.human?.kills||0)===1?'':'S'}`;}
}

function seeded(seed) {
  let value = (Number(seed) || 1) >>> 0;
  randomSource = () => { value = (value + 0x6D2B79F5) >>> 0; let t = value; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function sendRoom(message) {
  if (state.roomSocket?.readyState === WebSocket.OPEN) state.roomSocket.send(JSON.stringify(message));
  else toast('Room connection lost. Reconnect to continue.');
}
function beginOnlineBoard(payload) {
  state.online = true; state.tv = state.roomRole === 'viewer'; state.mode = payload.mode || state.mode;
  state.roomSeed = payload.seed; state.round = payload.round || 1; state.roomHostId = payload.hostId || state.roomHostId;
  state.players = (payload.players || []).map((p, i) => ({
    ...p, human: !state.tv && p.id === state.clientId, color: botColors[i % botColors.length],
    pos: v(Number(p.pos?.x) || 0, Number(p.pos?.y) || 0), move: null,
  }));
  fitCamera(arenaRoot.clientWidth||800,arenaRoot.clientHeight||550);
  state.human = state.players.find(p => p.human) || { id: null, alive: false, kills: 0, pos: v(0,0), human: false };
  state.botCount = Math.max(1, state.players.length - 1);
  state.phase = payload.phase === 'revealing' ? 'planning' : payload.phase || 'planning';state.roomPhase=state.phase;
  state.locked = false; state.selected = state.human.alive ? state.human.pos : null;
  state.lockedMoves = new Map(); state.beams = []; state.particles = []; state.lastResult = null; state.pendingRoomResult=null;
  seeded(payload.seed); buildArena(); rebuildVisuals(); updateHUD(); drawPlannedMove();
  document.body.classList.toggle('tv-view', state.tv);
  $('#new-match').disabled = true;
  setPlanningUI();
  $('#arena-title').textContent = state.tv ? 'Waiting for operative input.' : state.human.alive ? 'Set your position.' : 'Spectator mode.';
  $('#arena-kicker').textContent = state.tv ? 'SECTOR 07 · BROADCAST FEED' : `ROOM ${state.roomCode} · LIVE MATCH`;
  $('#sector-label').textContent = `ROOM ${state.roomCode} / ROUND ${String(state.round).padStart(2,'0')}`;
  $('#hint-label').textContent = state.tv ? 'OPERATIVE POSITIONS HIDDEN · WAITING FOR LOCK-IN' : 'TAP ARENA TO POSITION · DRAG TO AIM';
  $('#fire-button').disabled = state.tv || !state.human.alive;
  if (state.tv) { $('#phase-label').textContent = `TV VIEW · ROOM ${state.roomCode}`; $('#control-title').textContent = 'LIVE BROADCAST'; }
}
function acceptRoomRound(payload) {
  state.round = payload.round; state.roomSeed = payload.seed; state.roomHostId = payload.hostId || state.roomHostId;
  const prior = new Map(state.players.map(p => [p.id, p]));
  state.players = (payload.players || []).map((entry, i) => {
    const old = prior.get(entry.id);
    return { ...old, ...entry, human: !state.tv && entry.id === state.clientId, color: old?.color || botColors[i % botColors.length], pos: v(Number(entry.pos?.x) || 0, Number(entry.pos?.y) || 0), move: null };
  });
  fitCamera(arenaRoot.clientWidth||800,arenaRoot.clientHeight||550);
  state.human = state.players.find(p => p.human) || { id: null, alive: false, kills: 0, pos: v(0,0), human: false };
  state.phase = 'planning';state.roomPhase='planning'; state.locked = false; state.selected = state.human.alive ? state.human.pos : null; state.lockedMoves.clear();
  seeded(payload.seed); buildArena(); rebuildVisuals(); setPlanningUI(); updateHUD(); drawPlannedMove();
  $('#arena-title').textContent = state.tv ? 'Waiting for operative input.' : state.human.alive ? 'Set your position.' : 'Spectator mode.';
  $('#sector-label').textContent = `ROOM ${state.roomCode} / ROUND ${String(state.round).padStart(2,'0')}`;
  $('#hint-label').textContent = state.tv ? 'OPERATIVE POSITIONS HIDDEN · WAITING FOR LOCK-IN' : state.human.alive ? 'TAP ARENA TO POSITION · DRAG TO AIM' : 'BOTS ARE PLANNING · POSITIONS HIDDEN';
  $('#phase-label').textContent = state.tv ? `TV VIEW · ROOM ${state.roomCode}` : state.human.alive ? 'OPERATIVE INPUT REQUIRED' : 'SPECTATOR MODE';
  $('#fire-button').disabled = state.tv || !state.human.alive;
  $('#new-match').disabled = true;
  showBanner(`ROUND ${String(state.round).padStart(2,'0')}`, 'DEPLOY', 'Moves stay hidden until every operative locks');
}

function openRoomModal() { $('#room-error').textContent = ''; $('#room-modal').classList.add('open'); }
function paintRoomState(message) {
  if (message.code) state.roomCode = message.code;
  if (message.hostId) state.roomHostId = message.hostId;
  state.roomPhase=message.phase;
  const players = message.players || [];state.roomPlayers=players;
  $('#room-code-display').textContent = state.roomCode || '—';
  $('#lobby-count').textContent = `${String(players.length).padStart(2,'0')} / 06`;
  const roster = $('#lobby-roster'); roster.replaceChildren();
  players.forEach(player => {
    const row = document.createElement('div'); row.className = `lobby-player${player.team === 'Red' ? ' red' : ''}`;
    const dot = document.createElement('i'); const name = document.createElement('strong'); name.textContent = player.name;
    const role = document.createElement('small'); role.className = player.id === state.roomHostId ? 'host-mark' : ''; role.textContent = player.id === state.roomHostId ? 'HOST' : `${player.team.toUpperCase()} · ${player.ready?'READY':'NOT READY'}`;
    row.append(dot,name,role);
    if(state.clientId===state.roomHostId&&player.id!==state.roomHostId){
      const actions=document.createElement('span');actions.className='room-player-actions';
      const transfer=document.createElement('button');transfer.type='button';transfer.dataset.roomAction='transfer-host';transfer.dataset.playerId=player.id;transfer.textContent='MAKE HOST';transfer.title=`Transfer host to ${player.name}`;
      const kick=document.createElement('button');kick.type='button';kick.dataset.roomAction='kick-player';kick.dataset.playerId=player.id;kick.textContent='KICK';kick.title=`Remove ${player.name} from this room`;
      actions.append(transfer,kick);row.append(actions);
    }
    roster.appendChild(row);
  });
  const host = state.clientId === state.roomHostId && state.roomRole === 'player';
  const lobby=message.phase==='lobby';
  const self=players.find(p=>p.id===state.clientId);
  $('#start-room-match').hidden = !host||!lobby;
  $('#start-room-match').disabled = players.length < 2 || players.some(p=>!p.ready) || !lobby;
  $('#ready-toggle').hidden=host||!lobby||state.roomRole!=='player';
  $('#ready-toggle').textContent=self?.ready?'READY ✓':'READY UP';
  $('#back-to-lobby').hidden=!host||lobby;
  $('#end-game').hidden=!host||lobby||message.phase==='finished';
  $('#end-room').hidden=!host;
  $('#lobby-tv').hidden=state.roomRole==='viewer';
  $('#leave-room').textContent=state.roomRole==='viewer'?'EXIT TV':'LEAVE ROOM';
  $('#room-phase-label').textContent = message.phase === 'lobby' ? 'OPERATIVE LOBBY' : message.phase === 'finished' ? 'MATCH COMPLETE' : 'MATCH IN PROGRESS';
  $('#lobby-note').textContent = lobby ? players.length < 2 ? 'Share the room code. At least two operatives are needed.' : players.some(p=>!p.ready) ? 'Waiting for every operative to ready up.' : 'Everyone is ready. Host can start the match.' : `Round ${String(message.round || state.round).padStart(2,'0')} · ${message.watchers || 0} TV viewer${message.watchers === 1 ? '' : 's'}`;
  $('#room-choose').hidden = true; $('#room-lobby').hidden = false;
}
function handleRoomMessage(message) {
  if (message.type === 'connected') { state.clientId = message.clientId; return; }
  if (message.type === 'error') { $('#room-error').textContent = message.message; toast(message.message); return; }
  if (message.type === 'joined') {
    state.clientId = message.clientId; state.roomCode = message.code; state.roomRole = message.role;
    if (message.role === 'player') { document.body.classList.remove('tv-view'); $('#room-open').textContent='▣  ROOM LOBBY'; openRoomModal(); }
    else {
      state.online = false; state.tv = true; document.body.classList.add('tv-view'); $('#room-modal').classList.remove('open');
      const url=new URL(location.href);url.searchParams.delete('room');url.searchParams.set('tv',message.code);history.replaceState({},'',url);
    }
    return;
  }
  if (message.type === 'room-state') {
    state.roomHostId = message.hostId || state.roomHostId;
    state.roomPhase=message.phase;
    if (!state.tv && state.roomRole === 'player') paintRoomState(message);
    if (state.tv && !message.snapshot && !state.online) {
      beginOnlineBoard({players:message.players,mode:message.mode,seed:1,round:0,phase:'planning',hostId:message.hostId});
      $('#arena-title').textContent='TV feed ready. Waiting for host to start.';
      $('#hint-label').textContent='ROOM LOBBY · OPERATIVE POSITIONS HIDDEN';
      $('#phase-label').textContent=`TV VIEW · ROOM ${state.roomCode}`;
    }
    if (message.snapshot && !state.online) {
      const snapshot = { ...message.snapshot, hostId: message.hostId, players: message.snapshot.players };
      beginOnlineBoard(snapshot);
      if (message.snapshot.phase === 'revealing' && message.snapshot.moves) onReveal(message.snapshot.moves);
      else if (message.snapshot.phase === 'resolving' || message.snapshot.phase === 'finished') state.phase = message.snapshot.phase;
    }
    return;
  }
  if (message.type === 'match-start') { beginOnlineBoard(message); $('#room-modal').classList.remove('open'); showBanner('ROOM MATCH','DEPLOY',`Room ${state.roomCode} · moves are hidden`); return; }
  if (message.type === 'host-changed') { state.roomHostId=message.hostId;return; }
  if (message.type === 'back-to-lobby') { returnToRoomLobby(message);return; }
  if (message.type === 'game-ended') {
    state.roomPhase='finished';
    const latest=new Map((message.players||[]).map(p=>[p.id,p]));
    for(const p of state.players){const current=latest.get(p.id);if(current){p.alive=current.alive;p.kills=current.kills;}}
    state.phase='finished';$('#phase-label').textContent='MATCH ENDED';$('#arena-title').textContent='The host ended the match.';
    $('#control-title').textContent='MATCH ENDED BY HOST';$('#control-description').textContent='The room remains open. The host can return everyone to the lobby.';
    $('#fire-label').textContent='MATCH ENDED';$('#fire-button').disabled=true;updateHUD();showBanner('MATCH ENDED','HOST','Returning to the lobby is available in room controls.');return;
  }
  if (message.type === 'kicked') { exitRoom(message.message||'You were removed from the room.');return; }
  if (message.type === 'room-closed') { exitRoom(message.message||'The host ended this room.');return; }
  if (message.type === 'round-start') { acceptRoomRound(message); return; }
  if (message.type === 'move-count') {
    $('#players-ready').textContent = `${message.locked} / ${message.total} LOCKED`;
    if (state.locked) { $('#control-description').textContent = `Move hidden · ${message.locked} of ${message.total} operatives locked.`; $('#hint-label').textContent = `MOVE LOCKED · ${message.locked} / ${message.total} READY`;
      $('#arena-title').textContent = 'Move locked. Waiting for the volley.'; }
    return;
  }
  if (message.type === 'reveal-moves') { onReveal(message.moves); return; }
  if (message.type === 'turn-timeout') {
    state.phase = 'planning'; state.locked = false; state.lockedMoves.clear(); state.selected = state.human.alive ? state.human.pos : null; setPlanningUI(); toast('Turn timed out. Choose and lock your move again.'); return;
  }
  if (message.type === 'round-result') {
    if (state.phase==='locked') { state.pendingRoomResult=message; return; }
    applyRoomResult(message); return;
  }
}
function applyRoomResult(message) {
  state.roomPhase=message.winner?'finished':'resolving';
  const latest = new Map(message.players.map(p => [p.id,p]));
  for (const p of state.players) { const update = latest.get(p.id); if (update) { p.alive = update.alive; p.kills = update.kills; if(update.pos)p.pos=v(update.pos.x,update.pos.y); } }
  if (message.winner) {
    const humanWon=state.mode==='teams'?message.winner===`${String(state.human.team||'').toUpperCase()} TEAM`:message.winner===state.human.name;
    state.phase='finished'; $('#phase-label').textContent='MATCH COMPLETE'; $('#arena-title').textContent=state.tv?`${message.winner} WINS`:humanWon?'You survived.':`${message.winner} wins.`;
    $('#control-title').textContent='ROOM MATCH COMPLETE'; $('#control-description').textContent='The room is still open. Start another match or keep the TV feed open.';
    $('#fire-label').textContent='MATCH COMPLETE';$('#fire-button').disabled=true;showBanner('MATCH OVER',message.winner,'ROOM MATCH COMPLETE');
  }
  updateHUD();
}
function returnToRoomLobby(message) {
  state.roomCode ||= message.code; state.roomHostId=message.hostId||state.roomHostId; state.roomRole ||= 'player';
  beginOnlineBoard({players:message.players,mode:state.mode,seed:1,round:0,phase:'planning',hostId:state.roomHostId});
  state.roomPhase='lobby'; $('#arena-title').textContent=state.tv?'TV feed ready. Waiting for host to start.':'Back in the room lobby.';
  $('#control-title').textContent=state.tv?'TV LOBBY FEED':'ROOM LOBBY';
  $('#control-description').textContent=state.tv?'The host can start a new match when operatives are ready.':'Ready up when you are ready for the next match.';
  $('#hint-label').textContent='ROOM LOBBY · NO OPERATIVE POSITIONS SHOWN';
  $('#fire-label').textContent='WAITING';$('#fire-button').disabled=true;$('#undo-button').disabled=true;
  if(state.tv){document.body.classList.add('tv-view');$('#phase-label').textContent=`TV VIEW · ROOM ${state.roomCode}`;}
  else {$('#room-choose').hidden=true;$('#room-lobby').hidden=false;$('#room-modal').classList.add('open');}
}
function exitRoom(message) {
  const socket=state.roomSocket;state.roomSocket=null;state.roomCode=null;state.roomHostId=null;state.roomRole=null;state.roomPhase=null;
  socket?.close(1000,'Room ended');newMatch();
  if(message)toast(message);
}
function onReveal(moves) {
  if (!state.online || !moves || state.phase === 'resolving') return;
  state.lockedMoves = new Map(Object.entries(moves).map(([id, move]) => [id, { pos:v(move.pos.x,move.pos.y), aim:move.aim, weapon:move.weapon }]));
  state.phase='locked'; state.locked=true; removePlanned();
  $('#phase-label').textContent='VOLLEY INCOMING'; $('#players-ready').textContent=`${Object.keys(moves).length} / ${state.players.filter(p=>p.alive).length} LOCKED`;
  $('#hint-label').textContent='ALL MOVES LOCKED · REVEALING VOLLEY'; $('#arena-title').textContent='All moves locked.';
  showBanner('ALL MOVES LOCKED','REVEAL','');
  setTimeout(()=>resolveVolley(moves),320);
}
async function connectRoom(action, code = '') {
  $('#room-error').textContent = '';
  const name = $('#callsign').value.trim() || 'ROOKIE';
  if (action === 'create-room') {
    try {
      const response = await fetch('/api/rooms', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({name}) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Room creation failed.');
      code = result.code;
    } catch (error) { $('#room-error').textContent=error.message;return; }
    action = 'join-room';
  }
  if (!code) { $('#room-error').textContent='Enter a room code first.';return; }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const role = action === 'watch-room' ? 'viewer' : 'player';
  const oldSocket=state.roomSocket;
  const socket = new WebSocket(`${protocol}//${location.host}/ws/${encodeURIComponent(code.toUpperCase())}?role=${role}&name=${encodeURIComponent(name)}`);
  state.roomSocket = socket;
  if(oldSocket&&oldSocket.readyState<WebSocket.CLOSING)oldSocket.close(1000,'Changing room');
  socket.addEventListener('message',event=>{try{handleRoomMessage(JSON.parse(event.data));}catch{}});
  socket.addEventListener('close',()=>{if(state.roomSocket===socket)toast('Room connection closed.');});
  socket.addEventListener('error',()=>{$('#room-error').textContent='Could not connect to the Kala room server.';});
}

function showBanner(kicker,title,copy) {
  const el=$('#round-banner');el.querySelector('.eyebrow').textContent=kicker;el.querySelector('strong').textContent=title;el.querySelector('span:last-child').textContent=copy;el.classList.add('show');
  clearTimeout(showBanner.timer);showBanner.timer=setTimeout(()=>el.classList.remove('show'),1250);
}
function toast(text) {const el=$('#toast');el.textContent=text;el.classList.add('show');clearTimeout(state.toastTimeout);state.toastTimeout=setTimeout(()=>el.classList.remove('show'),1500);}

function fitCamera(w,h) {
  renderer.setSize(w,h,false);
  const aspect=w/h;
  view.h=state.online?Math.max(20,16.8/aspect):20;view.w=view.h*aspect;view.radius=Math.max(3.2,Math.min(view.w*.44,view.h*.39));
  camera.left=-view.w/2;camera.right=view.w/2;camera.top=view.h/2;camera.bottom=-view.h/2;camera.updateProjectionMatrix();
}
function resize() {
  const w=arenaRoot.clientWidth||800,h=arenaRoot.clientHeight||550;fitCamera(w,h);
  if(state.players.length){buildArena();rebuildVisuals();drawPlannedMove();}
}
new ResizeObserver(resize).observe(arenaRoot);

function canvasPoint(event) {
  const rect=renderer.domElement.getBoundingClientRect();
  return v(((event.clientX-rect.left)/rect.width-.5)*view.w,(.5-(event.clientY-rect.top)/rect.height)*view.h);
}
let pointerStart=null, pointerMoved=false;
renderer.domElement.addEventListener('pointerdown',event=>{
  if(state.phase!=='planning'||state.locked||!state.human.alive)return;
  event.preventDefault();renderer.domElement.setPointerCapture(event.pointerId);
  const p=canvasPoint(event);if(!pointInPolygon(p,state.arena)||state.obstacles.some(o=>pointInPolygon(p,o.points))){toast('Position must be inside the safe zone.');return;}
  pointerStart=p;pointerMoved=false;state.selected=p;
  const target=state.players.find(q=>q.alive&&!q.human&&(state.mode!=='teams'||q.team!==state.human.team));
  if(target)state.aim=Math.atan2(target.pos.y-p.y,target.pos.x-p.x);
  $('#arena-title').textContent='Move staged. Aim stays hidden.';
  $('#hint-label').textContent='POSITION STAGED · DRAG TO AIM · STILL HIDDEN';
  drawPlannedMove();
});
renderer.domElement.addEventListener('pointermove',event=>{
  if(!pointerStart||!state.selected)return;
  const p=canvasPoint(event);if(dist(pointerStart,p)>0.12)pointerMoved=true;
  if(pointerMoved){state.aim=Math.atan2(p.y-pointerStart.y,p.x-pointerStart.x);drawPlannedMove();}
});
renderer.domElement.addEventListener('pointerup',()=>{pointerStart=null;});
renderer.domElement.addEventListener('pointercancel',()=>{pointerStart=null;});

$('#fire-button').addEventListener('click',()=>{
  if(state.phase==='finished'){newMatch();return;}
  if(state.phase==='resolving')return;
  if(!state.human.alive){toast('Spectating active operatives.');return;}
  if(!state.selected){toast('Choose a position inside the arena first.');return;}
  state.locked=true;state.phase='locked';state.lockedMoves.set('human',{pos:state.selected,aim:state.aim,weapon:state.humanWeapon||'standard'});
  removePlanned();$('#fire-label').textContent='SHOT LOCKED';$('#fire-button').disabled=true;$('#undo-button').disabled=true;
  $('#control-title').textContent='MOVE COMMITTED';$('#control-description').textContent='Your position and shot are hidden. Waiting for the other operatives…';$('#hint-label').textContent='MOVE COMMITTED · WAITING FOR ALL OPERATIVES';$('#phase-label').textContent='AWAITING OPERATIVE INPUT';const living=state.players.filter(p=>p.alive).length;$('#players-ready').textContent=state.online?`1 / ${living} LOCKED`:`${living} / ${living} LOCKED`;
  showBanner('SHOT LOCKED','HIDDEN','Waiting for other operatives');
  if(state.online) {
    state.lockedMoves.delete('human');
    state.lockedMoves.set(state.clientId,{pos:state.selected,aim:state.aim,weapon:state.humanWeapon||'standard'});
    sendRoom({type:'move',move:{pos:{x:state.selected.x,y:state.selected.y},aim:state.aim,weapon:state.humanWeapon||'standard'}});
  } else setTimeout(()=>{if(state.phase==='locked')resolveVolley();},520);
});
$('#undo-button').addEventListener('click',()=>{if(state.phase!=='planning'||state.locked)return;state.selected=state.human.pos;state.aim=0;drawPlannedMove();toast('Move reset.');});
$('#new-match').addEventListener('click',()=>{newMatch();toast('New match initialized.');});
document.querySelectorAll('.mode-button').forEach(button=>button.addEventListener('click',()=>{
  if(state.online||state.round!==1||state.phase!=='planning'){toast('Mode changes start a new match.');return;}
  state.mode=button.dataset.mode;document.querySelectorAll('.mode-button').forEach(b=>b.classList.toggle('active',b===button));newMatch();
}));
$('#less-bots').addEventListener('click',()=>{if(state.online)return;state.botCount=clamp(state.botCount-1,1,6);$('#bot-count').textContent=String(state.botCount).padStart(2,'0');newMatch();});
$('#more-bots').addEventListener('click',()=>{if(state.online)return;state.botCount=clamp(state.botCount+1,1,6);$('#bot-count').textContent=String(state.botCount).padStart(2,'0');newMatch();});
$('#ricochet-button').addEventListener('click',()=>{
  if(state.human.kills<3){toast(`${3-state.human.kills} more eliminations to unlock.`);return;}
  state.humanWeapon=state.humanWeapon==='ricochet'?'standard':'ricochet';document.querySelectorAll('.weapon-card').forEach(b=>b.classList.toggle('selected',b.dataset.weapon===(state.humanWeapon||'standard')));toast(state.humanWeapon==='ricochet'?'Ricochet equipped. One bounce.':'Prism laser equipped.');
});
$('#help-button').addEventListener('click',()=>$('#modal').classList.add('open'));
$('#modal .modal-close').addEventListener('click',()=>$('#modal').classList.remove('open'));
$('#modal .modal-start').addEventListener('click',()=>$('#modal').classList.remove('open'));
$('#modal').addEventListener('click',e=>{if(e.target.id==='modal')$('#modal').classList.remove('open');});
$('#fullscreen-button').addEventListener('click',()=>{if(!document.fullscreenElement)document.documentElement.requestFullscreen?.();else document.exitFullscreen?.();});
$('#sound-button').addEventListener('click',()=>{state.sound=!state.sound;$('#sound-button').style.color=state.sound?'var(--cyan)':'#71808e';toast(state.sound?'Audio cues enabled.':'Audio cues muted.');});

$('#room-open').addEventListener('click',()=>{
  if(state.roomRole==='player'&&state.roomCode&&state.roomSocket?.readyState===WebSocket.OPEN){$('#room-choose').hidden=true;$('#room-lobby').hidden=false;openRoomModal();return;}
  state.roomRole=null;$('#room-choose').hidden=false;$('#room-lobby').hidden=true;openRoomModal();
});
$('#room-shortcut').addEventListener('click',()=>{
  if(state.tv){toast('TV view is read-only.');return;}
  if(state.roomRole==='player'&&state.roomCode){$('#room-choose').hidden=true;$('#room-lobby').hidden=false;openRoomModal();return;}
  $('#room-choose').hidden=false;$('#room-lobby').hidden=true;openRoomModal();
});
$('#create-room').addEventListener('click',()=>connectRoom('create-room'));
$('#join-room').addEventListener('click',()=>connectRoom('join-room',$('#room-code').value.trim().toUpperCase()));
$('#quick-join').addEventListener('click',()=>connectRoom('join-room',$('#quick-room-code').value.trim().toUpperCase()));
$('#quick-room-code').addEventListener('keydown',e=>{if(e.key==='Enter')connectRoom('join-room',$('#quick-room-code').value.trim().toUpperCase());});
const openTV = () => {
  if(state.tv){sendRoom({type:'leave-room'});state.roomSocket?.close();state.roomSocket=null;state.roomCode=null;state.roomRole=null;newMatch();return;}
  const code=state.roomCode||$('#quick-room-code').value.trim().toUpperCase()||$('#room-code').value.trim().toUpperCase();
  if(code){state.tv=true;state.phase='planning';document.body.classList.add('tv-view');rebuildVisuals();$('#phase-label').textContent='CONNECTING TO TV FEED';connectRoom('watch-room',code);}
  else {$('#room-choose').hidden=false;$('#room-lobby').hidden=true;openRoomModal();$('#room-code').focus();}
};
$('#quick-tv').addEventListener('click',openTV);
$('#tv-button').addEventListener('click',openTV);
$('#watch-room').addEventListener('click',()=>connectRoom('watch-room',$('#room-code').value.trim().toUpperCase()||state.roomCode||''));
$('#lobby-tv').addEventListener('click',()=>{if(state.roomCode)connectRoom('watch-room',state.roomCode);});
$('#start-room-match').addEventListener('click',()=>sendRoom({type:'start-match',mode:state.mode}));
$('#ready-toggle').addEventListener('click',()=>{
  const self=state.roomPlayers.find(p=>p.id===state.clientId);
  sendRoom({type:'set-ready',ready:!self?.ready});
});
$('#lobby-roster').addEventListener('click',event=>{
  const button=event.target.closest('button[data-room-action]');if(!button)return;
  const targetId=button.dataset.playerId;
  if(button.dataset.roomAction==='transfer-host'){
    if(window.confirm('Make this operative the room host?'))sendRoom({type:'transfer-host',targetId});
  } else if(button.dataset.roomAction==='kick-player'){
    if(window.confirm('Remove this operative from the room?'))sendRoom({type:'kick-player',targetId});
  }
});
$('#back-to-lobby').addEventListener('click',()=>{
  if(window.confirm('End the current match and return everyone to the room lobby?'))sendRoom({type:'back-to-lobby'});
});
$('#end-game').addEventListener('click',()=>{
  if(window.confirm('End the match now? The room will stay open so players can return to the lobby.'))sendRoom({type:'end-game'});
});
$('#end-room').addEventListener('click',()=>{
  if(window.confirm('End this room for everyone? All players and TV viewers will be disconnected.'))sendRoom({type:'end-room'});
});
$('#copy-room-link').addEventListener('click',async()=>{
  const invite=`${location.origin}${location.pathname}?room=${state.roomCode}`;
  try{await navigator.clipboard.writeText(invite);toast('Invite link copied.');}catch{$('#room-error').textContent=invite;}
});
$('#copy-room-code').addEventListener('click',async()=>{
  try{await navigator.clipboard.writeText(state.roomCode||'');toast('Room code copied.');}
  catch{$('#room-error').textContent=state.roomCode||'No room code available.';}
});
let tvViewLink='';
async function showTVQRCode(){
  if(!state.roomCode){toast('Create or join a room first.');return;}
  const url=new URL(location.pathname,location.origin);url.searchParams.set('tv',state.roomCode);
  tvViewLink=url.toString();
  $('#tv-qr-code-label').textContent=state.roomCode;
  $('#tv-qr-link').textContent=tvViewLink;
  $('#tv-qr-note').textContent=/^(localhost|127\.0\.0\.1)$/.test(location.hostname)?'Local address detected. For another device, open Kala using this computer’s network address first.':'Read-only screen · positions stay hidden until all players lock.';
  $('#tv-qr-modal').classList.add('open');
  try{await QRCode.toCanvas($('#tv-qr-canvas'),tvViewLink,{width:280,margin:2,errorCorrectionLevel:'H',color:{dark:'#0d2d46',light:'#e6fbda'}});}
  catch{toast('Could not create the TV QR code.');}
}
$('#show-tv-qr').addEventListener('click',showTVQRCode);
$('#tv-qr-close').addEventListener('click',()=>$('#tv-qr-modal').classList.remove('open'));
$('#tv-qr-modal').addEventListener('click',event=>{if(event.target.id==='tv-qr-modal')$('#tv-qr-modal').classList.remove('open');});
$('#copy-tv-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(tvViewLink);toast('TV view link copied.');}catch{toast(tvViewLink);}});
$('#leave-room').addEventListener('click',()=>{
  sendRoom({type:'leave-room'});exitRoom('Left the room.');$('#room-modal').classList.remove('open');
});
$('#room-modal .room-close').addEventListener('click',()=>$('#room-modal').classList.remove('open'));

const startupQuery=new URLSearchParams(location.search);
if(startupQuery.has('tv')) { $('#quick-room-code').value=startupQuery.get('tv'); connectRoom('watch-room',startupQuery.get('tv').toUpperCase()); }
else if(startupQuery.has('room')) { $('#room-code').value=startupQuery.get('room'); connectRoom('join-room',startupQuery.get('room').toUpperCase()); }

let audioContext=null;
function playShotSound(count) {
  if(!state.sound)return;
  try {
    audioContext ||= new (window.AudioContext||window.webkitAudioContext)();
    if(audioContext.state==='suspended')audioContext.resume();
    const now=audioContext.currentTime,osc=audioContext.createOscillator(),gain=audioContext.createGain();
    osc.type='sawtooth';osc.frequency.setValueAtTime(760,now);osc.frequency.exponentialRampToValueAtTime(180,now+.16);
    gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.055,now+.012);gain.gain.exponentialRampToValueAtTime(.0001,now+.2);
    osc.connect(gain);gain.connect(audioContext.destination);osc.start(now);osc.stop(now+.21);
    if(count>8){const o=audioContext.createOscillator(),g=audioContext.createGain();o.type='sine';o.frequency.value=90;g.gain.setValueAtTime(.025,now);g.gain.exponentialRampToValueAtTime(.0001,now+.32);o.connect(g);g.connect(audioContext.destination);o.start(now);o.stop(now+.33);}
  } catch {}
}

function animate(now) {
  requestAnimationFrame(animate);
  const sec=now*.001;
  ambientUniforms.uTime.value=sec;
  for(const p of state.players)if(p.visual){
    const {halo,outer,inner}=p.visualParts;
    halo.scale.setScalar(1+Math.sin(sec*3+p.pos.x)*.08);outer.rotation.z=sec*.28;inner.rotation.z=-sec*.4;
    if(p.human&&state.phase!=='planning'&&state.phase!=='locked')p.visual.scale.setScalar(1+Math.sin(sec*4)*.025);
  }
  const elapsed=now;
  updateBoundaryPulse(now);
  for(let i=state.beams.length-1;i>=0;i--){const beam=state.beams[i];const remain=beam.until-elapsed;if(remain<0){beam.objects.forEach(o=>{group.remove(o);o.geometry.dispose();o.material.dispose();});state.beams.splice(i,1);}else if(remain<360)beam.objects.forEach(o=>o.material.opacity*=.94);}
  for(let i=state.particles.length-1;i>=0;i--){const p=state.particles[i],t=(now-p.start)/p.life;if(t>=1){group.remove(p.object);p.object.geometry?.dispose();p.object.material?.dispose();state.particles.splice(i,1);continue;}
    if(p.flash){p.object.scale.setScalar(1+t*3);p.object.material.opacity=(1-t)*.55;}
    else{const attr=p.object.geometry.attributes.position;for(let j=0;j<attr.count;j++){attr.array[j*3]+=p.velocity[j*3]*.016;attr.array[j*3+1]+=p.velocity[j*3+1]*.016;attr.array[j*3+2]+=p.velocity[j*3+2]*.016;}attr.needsUpdate=true;p.object.material.opacity=1-t;p.object.material.size=.1*(1-t)+.025;}
  }
  renderer.render(scene,camera);
}

// Start after dimensions are measured so the first board fits mobile and TV canvases.
requestAnimationFrame(()=>{resize();newMatch();requestAnimationFrame(animate);});
