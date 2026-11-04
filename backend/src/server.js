import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const development = process.argv.includes('--dev') && process.env.NODE_ENV !== 'production' && !process.env.RENDER;
const port = Number(process.env.PORT || (development ? 8787 : 10000));
const rooms = new Map();
const maxPlayers = 6;
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const makeCode = () => Array.from(randomBytes(5), byte => alphabet[byte % alphabet.length]).join('');
const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' });res.end(JSON.stringify(body)); };
const send = (client, message) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message)); };
const listPlayers = room => [...room.players.values()].map(p => ({ ...p }));
function broadcast(room, message) {
  const payload = JSON.stringify(message);
  for (const client of [...room.players.keys(), ...room.viewers]) if (client.readyState === WebSocket.OPEN) client.send(payload);
}
function roomInfo(room) {
  return { type:'room-state', code:room.code, hostId:room.hostId, players:listPlayers(room), phase:room.phase, mode:room.game?.mode||room.mode, round:room.game?.round||0, watchers:room.viewers.size };
}
function isWinner(players, mode) {
  const alive=players.filter(p=>p.alive);
  return mode==='teams'?new Set(alive.map(p=>p.team)).size<=1:alive.length<=1;
}
function makeRoom() {
  let code;do code=makeCode();while(rooms.has(code));
  return {code,hostId:null,players:new Map(),viewers:new Set(),phase:'lobby',mode:'ffa',game:null,nextTimer:null,turnTimer:null};
}
function closeRoomIfEmpty(room) {
  if(room.players.size||room.viewers.size)return;
  clearTimeout(room.nextTimer);clearTimeout(room.turnTimer);rooms.delete(room.code);
}
function sendRoomState(room) { broadcast(room,roomInfo(room)); }
function revealIfReady(room) {
  if(room.phase!=='planning'||!room.game)return;
  const alive=[...room.players.values()].filter(p=>p.alive).length;
  if(room.game.moves.size<alive)return;
  clearTimeout(room.turnTimer);room.phase='revealing';
  broadcast(room,{type:'reveal-moves',round:room.game.round,moves:Object.fromEntries(room.game.moves)});
  room.turnTimer=setTimeout(()=>{
    if(room.phase==='revealing'){room.phase='planning';room.game.moves.clear();broadcast(room,{type:'turn-timeout',round:room.game.round});schedulePlanTimeout(room);}
  },120_000);
}
function schedulePlanTimeout(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer=setTimeout(()=>{
    if(room.phase==='planning'&&room.game){room.game.moves.clear();broadcast(room,{type:'turn-timeout',round:room.game.round});schedulePlanTimeout(room);}
  },120_000);
}
function attachPlayer(socket,room,name) {
  const isHost=!room.hostId,index=room.players.size;
  const player={id:socket.id,name:String(name||`PLAYER ${index+1}`).trim().slice(0,16)||`PLAYER ${index+1}`,team:index%2===0?'Blue':'Red',alive:true,kills:0,pos:null,ready:isHost};
  room.players.set(socket,player);room.hostId||=socket.id;socket.room=room;socket.role='player';
  send(socket,{type:'connected',clientId:socket.id});send(socket,{type:'joined',clientId:socket.id,code:room.code,role:'player'});sendRoomState(room);
}
function removePlayer(socket) {
  const room=socket.room;if(!room)return;
  if(socket.role==='player'){
    const player=room.players.get(socket);if(player&&room.game)player.alive=false;
    room.players.delete(socket);
    if(room.hostId===socket.id){room.hostId=room.players.keys().next().value?.id||null;const next=room.players.get([...room.players.keys()].find(c=>c.id===room.hostId));if(next)next.ready=true;}
  }
  room.viewers.delete(socket);socket.room=null;socket.role='guest';
  revealIfReady(room);sendRoomState(room);closeRoomIfEmpty(room);
}
function startGame(room,mode) {
  const players=listPlayers(room),radius=4.4;
  players.forEach((p,i)=>{
    const angle=-Math.PI/2+Math.PI*2*i/players.length;p.alive=true;p.kills=0;p.pos={x:Math.cos(angle)*radius,y:Math.sin(angle)*radius};
    const socket=[...room.players.keys()].find(client=>client.id===p.id);if(socket)room.players.set(socket,p);
  });
  room.mode=mode==='teams'?'teams':'ffa';room.game={mode:room.mode,round:1,seed:randomInt(1,0x7fffffff),moves:new Map()};room.phase='planning';schedulePlanTimeout(room);
  broadcast(room,{type:'match-start',...snapshot(room),hostId:room.hostId,code:room.code});sendRoomState(room);
}
function snapshot(room) {
  if(!room.game)return null;
  return {mode:room.game.mode,seed:room.game.seed,round:room.game.round,phase:room.phase,players:listPlayers(room),moves:room.phase==='revealing'?Object.fromEntries(room.game.moves):undefined,locked:room.game.moves.size};
}
function hostOnly(socket,room) { return socket.role==='player'&&socket.id===room.hostId; }

const httpServer=createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET'&&url.pathname==='/healthz'){res.writeHead(200,{'content-type':'text/plain'});res.end('ok');return;}
  if(req.method==='POST'&&url.pathname==='/api/rooms'){
    const room=makeRoom();rooms.set(room.code,room);json(res,{code:room.code},201);return;
  }
  if(development){res.writeHead(302,{location:`http://localhost:5173${req.url||'/'}`,'cache-control':'no-store'});res.end();return;}
  try{
    let relative=decodeURIComponent(url.pathname).replace(/^[/\\]+/,'');
    if(relative.split(/[/\\]/).includes('..')){res.writeHead(400);res.end('Bad path');return;}
    if(!relative)relative='index.html';
    let file=join(process.cwd(),'frontend','dist',relative);
    try{await stat(file);}catch{file=join(process.cwd(),'frontend','dist','index.html');}
    const body=await readFile(file),types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
    res.writeHead(200,{'content-type':types[extname(file)]||'application/octet-stream','cache-control':extname(file)==='.html'?'no-cache':'public, max-age=31536000, immutable'});res.end(body);
  }catch{res.writeHead(500);res.end('Server error');}
});

const wss=new WebSocketServer({noServer:true,maxPayload:16_384});
httpServer.on('upgrade',(req,socket,head)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),match=url.pathname.match(/^\/ws\/([A-Z0-9]{5})$/i);
  if(!match){socket.destroy();return;}
  wss.handleUpgrade(req,socket,head,client=>wss.emit('connection',client,req,match[1].toUpperCase()));
});

wss.on('connection',(socket,req,code)=>{
  socket.id=randomUUID();socket.role='guest';
  const room=rooms.get(code),url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(!room){send(socket,{type:'error',message:'Room not found. Check the code and try again.'});socket.close(1008,'Room not found');return;}
  const role=url.searchParams.get('role')==='viewer'?'viewer':'player',name=url.searchParams.get('name')||'ROOKIE';
  if(role==='player'&&room.phase!=='lobby'){send(socket,{type:'error',message:'This match has already started.'});socket.close(1008,'Match already started');return;}
  if(role==='player'&&room.players.size>=maxPlayers){send(socket,{type:'error',message:'This room is full.'});socket.close(1008,'Room full');return;}
  if(role==='player')attachPlayer(socket,room,name);
  else{
    socket.room=room;socket.role='viewer';room.viewers.add(socket);
    send(socket,{type:'connected',clientId:socket.id});send(socket,{type:'joined',clientId:socket.id,code:room.code,role:'viewer'});
    send(socket,{...roomInfo(room),snapshot:snapshot(room)});sendRoomState(room);
  }
  socket.on('message',buffer=>{
    let msg;try{msg=JSON.parse(buffer.toString());}catch{return;}
    const current=socket.room;if(!current)return;
    if(msg.type==='start-match'){
      if(!hostOnly(socket,current)||current.phase!=='lobby')return;
      if(current.players.size<2){send(socket,{type:'error',message:'Invite at least one operative before starting.'});return;}
      if([...current.players.values()].some(player=>!player.ready)){send(socket,{type:'error',message:'Wait until every operative is ready.'});return;}
      startGame(current,msg.mode);return;
    }
    if(msg.type==='set-ready'){
      const player=current.players.get(socket);if(!player||current.phase!=='lobby'||socket.id===current.hostId)return;
      player.ready=Boolean(msg.ready);sendRoomState(current);return;
    }
    if(msg.type==='transfer-host'){
      if(!hostOnly(socket,current))return;
      const targetSocket=[...current.players.keys()].find(client=>client.id===msg.targetId),target=targetSocket&&current.players.get(targetSocket);
      if(!target){send(socket,{type:'error',message:'That operative is no longer in the room.'});return;}
      current.hostId=target.id;target.ready=true;broadcast(current,{type:'host-changed',hostId:current.hostId});sendRoomState(current);return;
    }
    if(msg.type==='kick-player'){
      if(!hostOnly(socket,current)||msg.targetId===socket.id)return;
      const target=[...current.players.keys()].find(client=>client.id===msg.targetId);if(!target)return;
      send(target,{type:'kicked',message:'The host removed you from the room.'});target.close(4001,'Removed by host');return;
    }
    if(msg.type==='back-to-lobby'){
      if(!hostOnly(socket,current)||current.phase==='lobby')return;
      clearTimeout(current.turnTimer);clearTimeout(current.nextTimer);current.phase='lobby';current.game=null;
      for(const player of current.players.values()){player.alive=true;player.kills=0;player.pos=null;player.ready=player.id===current.hostId;}
      broadcast(current,{type:'back-to-lobby',hostId:current.hostId,players:listPlayers(current),code:current.code});sendRoomState(current);return;
    }
    if(msg.type==='end-game'){
      if(!hostOnly(socket,current)||!current.game||current.phase==='lobby'||current.phase==='finished')return;
      clearTimeout(current.turnTimer);clearTimeout(current.nextTimer);current.phase='finished';
      broadcast(current,{type:'game-ended',message:'The host ended the match.',players:listPlayers(current),round:current.game.round});sendRoomState(current);return;
    }
    if(msg.type==='end-room'){
      if(!hostOnly(socket,current))return;
      current.phase='closed';clearTimeout(current.turnTimer);clearTimeout(current.nextTimer);
      broadcast(current,{type:'room-closed',message:'The host ended this room.'});
      for(const client of [...current.players.keys(),...current.viewers])client.close(1000,'Room ended by host');
      closeRoomIfEmpty(current);return;
    }
    if(msg.type==='move'){
      if(socket.role!=='player'||current.phase!=='planning'||!current.game)return;
      const player=current.players.get(socket);if(!player?.alive||current.game.moves.has(socket.id))return;
      const x=Number(msg.move?.pos?.x),y=Number(msg.move?.pos?.y),aim=Number(msg.move?.aim);if(![x,y,aim].every(Number.isFinite))return;
      current.game.moves.set(socket.id,{pos:{x:Math.max(-20,Math.min(20,x)),y:Math.max(-20,Math.min(20,y))},aim:Math.atan2(Math.sin(aim),Math.cos(aim)),weapon:msg.move.weapon==='ricochet'?'ricochet':'standard'});
      const alive=[...current.players.values()].filter(p=>p.alive).length;
      broadcast(current,{type:'move-count',locked:current.game.moves.size,total:alive,round:current.game.round});
      revealIfReady(current);return;
    }
    if(msg.type==='round-resolution'){
      if(socket.id!==current.hostId||current.phase!=='revealing'||!current.game)return;
      for(const update of Array.isArray(msg.players)?msg.players:[]){
        const player=[...current.players.values()].find(p=>p.id===update.id);if(!player)continue;
        player.alive=Boolean(update.alive);player.kills=Math.max(0,Math.min(999,Number(update.kills)||0));
        if(Number.isFinite(update.pos?.x)&&Number.isFinite(update.pos?.y))player.pos={x:update.pos.x,y:update.pos.y};
      }
      const alive=listPlayers(current).filter(p=>p.alive);let winner=null;
      if(isWinner(listPlayers(current),current.game.mode))winner=alive.length?current.game.mode==='teams'?`${alive[0].team.toUpperCase()} TEAM`:alive[0].name:'DRAW';
      current.phase=winner?'finished':'resolving';
      broadcast(current,{type:'round-result',players:listPlayers(current),winner,round:current.game.round});sendRoomState(current);
      clearTimeout(current.turnTimer);
      if(!winner)current.nextTimer=setTimeout(()=>{
        if(!rooms.has(current.code)||current.phase!=='resolving')return;
        current.game.round++;current.game.seed=randomInt(1,0x7fffffff);current.game.moves=new Map();current.phase='planning';schedulePlanTimeout(current);
        broadcast(current,{type:'round-start',...snapshot(current),hostId:current.hostId});sendRoomState(current);
      },2100);
    }
    if(msg.type==='leave-room')socket.close(1000,'Left room');
  });
  socket.on('close',()=>removePlayer(socket));
  socket.on('error',()=>removePlayer(socket));
});

httpServer.listen(port,'0.0.0.0',()=>console.log(`Kala listening on 0.0.0.0:${port}${development?' (API + WebSocket)':''}`));
