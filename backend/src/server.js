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
const listPlayers = room => [...room.players.values(), ...room.bots.values()].map(p => ({ ...p }));
function visiblePlayers(room,recipientId=null) {
  const reveal=room.revealedMoves;
  return listPlayers(room).map(player=>reveal||player.id===recipientId?player:{...player,pos:null});
}
function broadcast(room, message) {
  const payload = JSON.stringify(message);
  for (const client of [...room.players.keys(), ...room.viewers]) if (client.readyState === WebSocket.OPEN) client.send(payload);
}
function roomInfo(room,recipientId=null) {
  return { type:'room-state', code:room.code, hostId:room.hostId, players:visiblePlayers(room,recipientId), phase:room.phase, mode:room.game?.mode||room.mode, round:room.game?.round||0, roundLimit:room.game?.roundLimit??room.roundLimit, botCount:room.botCount, watchers:room.viewers.size };
}
function isWinner(players, mode, round, roundLimit) {
  const alive=players.filter(p=>p.alive);
  return (mode==='teams'?new Set(alive.map(p=>p.team)).size<=1:alive.length<=1) || (roundLimit>0&&round>=roundLimit);
}
function winnerName(players,mode,round,roundLimit){
  const alive=players.filter(p=>p.alive);
  if(!alive.length&&!(roundLimit>0&&round>=roundLimit))return 'DRAW';
  if(mode==='teams'&&new Set(alive.map(p=>p.team)).size===1)return `${alive[0].team.toUpperCase()} TEAM`;
  if(mode==='ffa'&&alive.length===1)return alive[0].name;
  const scores=new Map();for(const p of players){const key=mode==='teams'?p.team:p.id;scores.set(key,(scores.get(key)||0)+p.kills);}
  const high=Math.max(0,...scores.values()),top=[...scores].filter(([,score])=>score===high);
  if(top.length!==1)return 'DRAW';return mode==='teams'?`${String(top[0][0]).toUpperCase()} TEAM`:players.find(p=>p.id===top[0][0])?.name||'DRAW';
}
function makeRoom() {
  let code;do code=makeCode();while(rooms.has(code));
  return {code,hostId:null,players:new Map(),bots:new Map(),resumeTimers:new Map(),viewers:new Set(),phase:'lobby',mode:'ffa',game:null,botCount:2,roundLimit:7,revealedMoves:false,nextTimer:null,turnTimer:null};
}
function closeRoomIfEmpty(room) {
  if(room.players.size||room.viewers.size)return;
  clearTimeout(room.nextTimer);clearTimeout(room.turnTimer);rooms.delete(room.code);
}
function sendRoomState(room) {
  for(const socket of room.players.keys())send(socket,roomInfo(room,socket.id));
  for(const socket of room.viewers)send(socket,roomInfo(room));
}
function broadcastMatchState(room,type) {
  for(const socket of room.players.keys())send(socket,{type,...snapshot(room,socket.id),hostId:room.hostId,code:room.code});
  for(const socket of room.viewers)send(socket,{type,...snapshot(room),hostId:room.hostId,code:room.code});
}
function revealIfReady(room) {
  if(room.phase!=='planning'||!room.game)return;
  const alive=listPlayers(room).filter(p=>p.alive).length;
  if(room.game.moves.size<alive)return;
  clearTimeout(room.turnTimer);room.phase='revealing';room.revealedMoves=true;
  // Reveal the simultaneous move set only after every living player has locked.
  broadcast(room,{type:'reveal-moves',round:room.game.round,moves:Object.fromEntries(room.game.moves)});
  room.turnTimer=setTimeout(()=>{
    if(room.phase==='revealing'){room.phase='planning';room.revealedMoves=false;room.game.moves.clear();broadcast(room,{type:'turn-timeout',round:room.game.round});schedulePlanTimeout(room);}
  },120_000);
}
function schedulePlanTimeout(room) {
  clearTimeout(room.turnTimer);
  room.turnTimer=setTimeout(()=>{
    if(room.phase==='planning'&&room.game){room.game.moves.clear();broadcast(room,{type:'turn-timeout',round:room.game.round});schedulePlanTimeout(room);}
  },120_000);
}
function attachPlayer(socket,room,name,resumeToken=null) {
  const suspended=[...room.players.entries()].find(([,player])=>player.resumeToken===resumeToken&&player.connected===false);
  let player;
  if(suspended){
    const [oldSocket,saved]=suspended;player=saved;clearTimeout(room.resumeTimers.get(player.id));room.resumeTimers.delete(player.id);room.players.delete(oldSocket);oldSocket.room=null;oldSocket.role='replaced';oldSocket.close(1000,'Seat resumed');socket.id=player.id;player.connected=true;player.name=String(name||player.name).trim().slice(0,16)||player.name;
  }else{
    if(room.phase!=='lobby')return false;
    const index=[...room.players.values()].filter(p=>p.connected!==false).length,isHost=!room.hostId;
    player={id:socket.id,resumeToken:randomUUID(),name:String(name||('PLAYER '+(index+1))).trim().slice(0,16)||('PLAYER '+(index+1)),team:index%2===0?'Blue':'Red',alive:true,kills:0,pos:null,ready:isHost,connected:true};
    room.hostId||=socket.id;room.botCount=Math.min(room.botCount,Math.max(0,maxPlayers-index-1));
  }
  room.players.set(socket,player);socket.room=room;socket.role='player';
  send(socket,{type:'connected',clientId:socket.id});send(socket,{type:'joined',clientId:socket.id,code:room.code,role:'player',seatToken:player.resumeToken,resumed:Boolean(suspended)});
  if(room.game)send(socket,{type:'match-start',...snapshot(room,socket.id),hostId:room.hostId,code:room.code});else sendRoomState(room);
  if(suspended)sendRoomState(room);return true;
}
function reassignHost(room){
  const next=[...room.players.entries()].find(([,player])=>player.connected!==false);room.hostId=next?.[1].id||null;if(next)next[1].ready=true;
  broadcast(room,{type:'host-changed',hostId:room.hostId});
}
function removePlayer(socket) {
  const room=socket.room;if(!room)return;
  if(socket.role==='player'){
    const player=room.players.get(socket);if(player){room.game?.moves.delete(socket.id);if(room.game)player.alive=false;
      if(socket.permanentLeave){room.players.delete(socket);clearTimeout(room.resumeTimers.get(player.id));room.resumeTimers.delete(player.id);if(room.hostId===player.id)reassignHost(room);}
      else{player.connected=false;player.ready=false;const timer=setTimeout(()=>{const current=[...room.players.entries()].find(([,p])=>p.id===player.id);if(!current||current[1].connected!==false)return;room.players.delete(current[0]);room.resumeTimers.delete(player.id);if(room.hostId===player.id)reassignHost(room);sendRoomState(room);closeRoomIfEmpty(room);},120_000);room.resumeTimers.set(player.id,timer);}
    }
  }
  room.viewers.delete(socket);socket.room=null;socket.role='guest';
  if(room.phase==='revealing'&&room.game)broadcast(room,{type:'reveal-moves',round:room.game.round,moves:Object.fromEntries(room.game.moves)});else revealIfReady(room);
  sendRoomState(room);closeRoomIfEmpty(room);
}
function startGame(room,mode,botCount=room.botCount,roundLimit=room.roundLimit) {
  room.bots.clear();const connectedCount=[...room.players.values()].filter(p=>p.connected!==false).length;room.botCount=Math.max(0,Math.min(maxPlayers-connectedCount,Number(botCount)||0));room.roundLimit=[0,5,7,10].includes(Number(roundLimit))?Number(roundLimit):7;
  const botNames=['VEX','GHOST','NYX','ROOK','ECHO'];
  for(let i=0;i<room.botCount;i++){const index=connectedCount+i;room.bots.set(`bot-${room.code}-${i+1}`,{id:`bot-${room.code}-${i+1}`,name:botNames[i%botNames.length],team:index%2===0?'Blue':'Red',alive:true,kills:0,pos:null,ready:true,bot:true});}
  const connected=[...room.players.values()].filter(p=>p.connected!==false),activeBotCount=Math.min(room.botCount,Math.max(0,maxPlayers-connected.length));room.botCount=activeBotCount;
  const players=[...connected,...room.bots.values()],radius=4.4;
  players.forEach((p,i)=>{
    const angle=-Math.PI/2+Math.PI*2*i/players.length;p.alive=true;p.kills=0;p.pos={x:Math.cos(angle)*radius,y:Math.sin(angle)*radius};
    const socket=[...room.players.keys()].find(client=>client.id===p.id);if(socket)room.players.set(socket,p);else room.bots.set(p.id,p);
  });
  room.mode=mode==='teams'?'teams':'ffa';room.game={mode:room.mode,round:1,roundLimit:room.roundLimit,startPlayerCount:players.length,seed:randomInt(1,0x7fffffff),moves:new Map()};room.revealedMoves=false;room.phase='planning';schedulePlanTimeout(room);
  broadcastMatchState(room,'match-start');sendRoomState(room);
}
function snapshot(room,recipientId=null) {
  if(!room.game)return null;
  return {mode:room.game.mode,seed:room.game.seed,round:room.game.round,roundLimit:room.game.roundLimit,startPlayerCount:room.game.startPlayerCount,botCount:room.botCount,phase:room.phase,players:visiblePlayers(room,recipientId),moves:room.revealedMoves?Object.fromEntries(room.game.moves):undefined,locked:room.game.moves.size};
}
function hostOnly(socket,room) { return socket.role==='player'&&socket.id===room.hostId; }

const httpServer=createServer(async(req,res)=>{
  const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(req.method==='GET'&&url.pathname==='/healthz'){res.writeHead(200,{'content-type':'text/plain'});res.end('ok');return;}
  if(req.method==='POST'&&url.pathname==='/api/rooms'){
    let config={};try{const chunks=[];for await(const chunk of req)chunks.push(chunk);config=JSON.parse(Buffer.concat(chunks).toString()||'{}');}catch{json(res,{error:'Invalid room setup.'},400);return;}
    const room=makeRoom();room.botCount=Math.max(0,Math.min(maxPlayers,Number(config.botCount??room.botCount)||0));room.roundLimit=[0,5,7,10].includes(Number(config.roundLimit))?Number(config.roundLimit):7;room.mode=config.mode==='teams'?'teams':'ffa';rooms.set(room.code,room);json(res,{code:room.code},201);return;
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
  const resumeToken=url.searchParams.get('resume'),resumeMatch=[...room.players.values()].some(player=>player.resumeToken===resumeToken&&player.connected===false);
  if(role==='player'&&resumeToken&&!resumeMatch){send(socket,{type:'error',message:'Your saved room seat is no longer valid. Join the room again.'});socket.close(1008,'Seat expired');return;}
  if(role==='player'&&room.phase!=='lobby'&&!resumeMatch){send(socket,{type:'error',message:'This match has already started.'});socket.close(1008,'Match already started');return;}
  if(role==='player'&&[...room.players.values()].filter(player=>player.connected!==false).length>=maxPlayers&&!resumeMatch){send(socket,{type:'error',message:'This room is full.'});socket.close(1008,'Room full');return;}
  if(role==='player')attachPlayer(socket,room,name,resumeToken);
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
      if([...current.players.values()].filter(player=>player.connected!==false).length<2){send(socket,{type:'error',message:'At least two players must be connected before starting.'});return;}
      if(![0,5,7,10].includes(Number(current.roundLimit))){send(socket,{type:'error',message:'Choose a round count before starting.'});return;}
      startGame(current,msg.mode,msg.botCount,msg.roundLimit);return;
    }
    if(msg.type==='set-match-options'){
      if(!hostOnly(socket,current)||current.phase!=='lobby')return;
      current.botCount=Math.max(0,Math.min(maxPlayers-[...current.players.values()].filter(p=>p.connected!==false).length,Number(msg.botCount)||0));
      current.roundLimit=[0,5,7,10].includes(Number(msg.roundLimit))?Number(msg.roundLimit):current.roundLimit;if(msg.mode==='teams'||msg.mode==='ffa')current.mode=msg.mode;sendRoomState(current);return;
    }
    if(msg.type==='set-team'){
      if(!hostOnly(socket,current)||current.phase!=='lobby')return;const target=[...current.players.values()].find(player=>player.id===msg.targetId&&player.connected!==false);if(!target)return;target.team=target.team==='Red'?'Blue':'Red';sendRoomState(current);return;
    }
    if(msg.type==='set-ready'){
      const player=current.players.get(socket);if(!player||current.phase!=='lobby'||socket.id===current.hostId)return;
      player.ready=Boolean(msg.ready);sendRoomState(current);return;
    }
    if(msg.type==='transfer-host'){
      if(!hostOnly(socket,current))return;
      const targetSocket=[...current.players.keys()].find(client=>client.id===msg.targetId&&current.players.get(client)?.connected!==false),target=targetSocket&&current.players.get(targetSocket);
      if(!target){send(socket,{type:'error',message:'That operative is no longer in the room.'});return;}
      current.hostId=target.id;target.ready=true;broadcast(current,{type:'host-changed',hostId:current.hostId});sendRoomState(current);return;
    }
    if(msg.type==='kick-player'){
      if(!hostOnly(socket,current)||msg.targetId===socket.id)return;
      const target=[...current.players.keys()].find(client=>client.id===msg.targetId);if(!target)return;
      send(target,{type:'kicked',message:'The host removed you from the room.'});target.permanentLeave=true;target.close(4001,'Removed by host');return;
    }
    if(msg.type==='back-to-lobby'){
      if(!hostOnly(socket,current)||current.phase==='lobby')return;
      clearTimeout(current.turnTimer);clearTimeout(current.nextTimer);current.phase='lobby';current.game=null;current.bots.clear();current.revealedMoves=false;
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
      current.phase='closed';clearTimeout(current.turnTimer);clearTimeout(current.nextTimer);for(const timer of current.resumeTimers.values())clearTimeout(timer);current.resumeTimers.clear();for(const client of current.players.keys())client.permanentLeave=true;
      broadcast(current,{type:'room-closed',message:'The host ended this room.'});
      for(const client of [...current.players.keys(),...current.viewers])client.close(1000,'Room ended by host');
      closeRoomIfEmpty(current);return;
    }
    if(msg.type==='bot-moves'){
      if(!hostOnly(socket,current)||current.phase!=='planning'||!current.game)return;
      for(const [id,move] of Object.entries(msg.moves||{})){const bot=current.bots.get(id);if(!bot?.alive||current.game.moves.has(id))continue;const x=Number(move?.pos?.x),y=Number(move?.pos?.y),aim=Number(move?.aim);if(![x,y,aim].every(Number.isFinite))continue;current.game.moves.set(id,{pos:{x:Math.max(-20,Math.min(20,x)),y:Math.max(-20,Math.min(20,y))},aim:Math.atan2(Math.sin(aim),Math.cos(aim)),weapon:move.weapon==='ricochet'?'ricochet':'standard'});}
      const alive=listPlayers(current).filter(p=>p.alive).length;broadcast(current,{type:'move-count',locked:current.game.moves.size,total:alive,round:current.game.round});revealIfReady(current);return;
    }
    if(msg.type==='move'){
      if(socket.role!=='player'||current.phase!=='planning'||!current.game)return;
      const player=current.players.get(socket);if(!player?.alive||current.game.moves.has(socket.id))return;
      const x=Number(msg.move?.pos?.x),y=Number(msg.move?.pos?.y),aim=Number(msg.move?.aim);if(![x,y,aim].every(Number.isFinite))return;
      current.game.moves.set(socket.id,{pos:{x:Math.max(-20,Math.min(20,x)),y:Math.max(-20,Math.min(20,y))},aim:Math.atan2(Math.sin(aim),Math.cos(aim)),weapon:msg.move.weapon==='ricochet'?'ricochet':'standard'});
      const alive=listPlayers(current).filter(p=>p.alive).length;
      broadcast(current,{type:'move-count',locked:current.game.moves.size,total:alive,round:current.game.round});
      revealIfReady(current);return;
    }
    if(msg.type==='round-resolution'){
      if(socket.id!==current.hostId||current.phase!=='revealing'||!current.game)return;
      for(const update of Array.isArray(msg.players)?msg.players:[]){
        const player=[...current.players.values()].find(p=>p.id===update.id)||current.bots.get(update.id);if(!player)continue;
        player.alive=Boolean(update.alive);player.kills=Math.max(0,Math.min(999,Number(update.kills)||0));
        if(Number.isFinite(update.pos?.x)&&Number.isFinite(update.pos?.y))player.pos={x:update.pos.x,y:update.pos.y};
      }
      const alive=listPlayers(current).filter(p=>p.alive);let winner=null;
      if(isWinner(listPlayers(current),current.game.mode,current.game.round,current.game.roundLimit))winner=winnerName(listPlayers(current),current.game.mode,current.game.round,current.game.roundLimit);
      current.phase=winner?'finished':'resolving';
      broadcast(current,{type:'round-result',players:listPlayers(current),moves:Object.fromEntries(current.game.moves),winner,round:current.game.round});sendRoomState(current);
      clearTimeout(current.turnTimer);
      if(!winner)current.nextTimer=setTimeout(()=>{
        if(!rooms.has(current.code)||current.phase!=='resolving')return;
        current.game.round++;current.game.seed=randomInt(1,0x7fffffff);current.game.moves=new Map();current.revealedMoves=false;current.phase='planning';schedulePlanTimeout(current);
        broadcastMatchState(current,'round-start');sendRoomState(current);
      },2100);
    }
    if(msg.type==='leave-room'){socket.permanentLeave=true;socket.close(1000,'Left room');}
  });
  socket.on('close',()=>removePlayer(socket));
  socket.on('error',()=>removePlayer(socket));
});

httpServer.listen(port,'0.0.0.0',()=>console.log(`Kala listening on 0.0.0.0:${port}${development?' (API + WebSocket)':''}`));
