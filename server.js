const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const WORDS = require('./words');

const PORT = process.env.PORT || 3000;
const ROUND_SECONDS = 90;
const HINT_AT = 45; // 剩余45秒时提示第一个字

const server = http.createServer((req, res) => {
  const file = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fp = path.join(__dirname, 'public', file);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(fp);
    const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map(); // code -> room
let nextId = 1;

function makeRoom(code) {
  const room = {
    code,
    hostId: null,
    players: new Map(), // id -> {id,name,ws,score}
    state: 'lobby',     // lobby | playing | over
    round: 0,
    totalRounds: 0,
    order: [],          // 画手顺序
    word: null,
    usedWords: new Set(),
    correctSet: new Set(),
    timer: null,
    hintTimer: null,
    endsAt: 0
  };
  rooms.set(code, room);
  return room;
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}
function broadcast(room, msg, exceptId) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}
function playerList(room) {
  return [...room.players.values()].map(p => ({
    id: p.id, name: p.name, score: p.score,
    isHost: p.id === room.hostId
  }));
}
function broadcastPlayers(room) {
  broadcast(room, { t: 'players', players: playerList(room), hostId: room.hostId, state: room.state });
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pickWord(room) {
  const avail = WORDS.filter(w => !room.usedWords.has(w.answer));
  const pool = avail.length ? avail : WORDS; // 用完就重置
  if (!avail.length) room.usedWords.clear();
  const w = pool[Math.floor(Math.random() * pool.length)];
  room.usedWords.add(w.answer);
  return w;
}

function startGame(room) {
  room.state = 'playing';
  room.round = 0;
  room.order = shuffle([...room.players.keys()]);
  room.totalRounds = room.order.length; // 每人画一次
  for (const p of room.players.values()) p.score = 0;
  broadcastPlayers(room);
  broadcast(room, { t: 'gameStart', totalRounds: room.totalRounds });
  startRound(room);
}

function startRound(room) {
  room.round++;
  room.correctSet = new Set();
  room.word = pickWord(room);
  const drawerId = room.order[(room.round - 1) % room.order.length];
  room.drawerId = drawerId;
  room.endsAt = Date.now() + ROUND_SECONDS * 1000;

  const drawer = room.players.get(drawerId);
  broadcast(room, {
    t: 'round',
    round: room.round,
    totalRounds: room.totalRounds,
    drawerId,
    drawerName: drawer ? drawer.name : '???',
    duration: ROUND_SECONDS,
    wordLen: [...room.word.answer].length,
    category: room.word.category
  });
  if (drawer) send(drawer.ws, { t: 'yourWord', word: room.word.answer, meaning: room.word.meaning });

  clearTimeout(room.timer);
  clearTimeout(room.hintTimer);
  room.hintTimer = setTimeout(() => {
    if (room.state !== 'playing') return;
    broadcast(room, { t: 'hint', hint: `第一个字是「${[...room.word.answer][0]}」` }, room.drawerId);
  }, (ROUND_SECONDS - HINT_AT) * 1000);
  room.timer = setTimeout(() => endRound(room, 'timeup'), ROUND_SECONDS * 1000);
}

function endRound(room, reason) {
  clearTimeout(room.timer);
  clearTimeout(room.hintTimer);
  broadcast(room, {
    t: 'roundEnd',
    reason,
    word: room.word.answer,
    meaning: room.word.meaning,
    category: room.word.category,
    players: playerList(room)
  });
  if (room.round >= room.totalRounds) {
    room.state = 'over';
    const ranking = playerList(room).sort((a, b) => b.score - a.score);
    setTimeout(() => broadcast(room, { t: 'gameOver', ranking }), 5000);
  } else {
    setTimeout(() => { if (room.state === 'playing') startRound(room); }, 5000);
  }
}

function norm(s) { return (s || '').replace(/\s+/g, ''); }

wss.on('connection', (ws) => {
  const id = 'p' + (nextId++);
  let room = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.t === 'join') {
      const code = norm(msg.room).toUpperCase() || '8888';
      const name = (msg.name || '招远银').slice(0, 12);
      room = rooms.get(code) || makeRoom(code);
      if (room.state !== 'lobby') { send(ws, { t: 'error', text: '这屋已经开局了，等下一局吧' }); room = null; return; }
      if (room.players.size >= 8) { send(ws, { t: 'error', text: '房间满员（8人）了' }); room = null; return; }
      room.players.set(id, { id, name, ws, score: 0 });
      if (!room.hostId) room.hostId = id;
      send(ws, { t: 'joined', room: code, playerId: id, words: WORDS.length });
      broadcastPlayers(room);
      broadcast(room, { t: 'chat', sys: true, text: `${name} 进了屋` }, id);
      return;
    }
    if (!room) return;
    const me = room.players.get(id);
    if (!me) return;

    switch (msg.t) {
      case 'start':
        if (id === room.hostId && room.state === 'lobby' && room.players.size >= 2) startGame(room);
        else if (room.players.size < 2) send(ws, { t: 'error', text: '至少得两个人才能开局' });
        break;

      case 'stroke': // {x0,y0,x1,y1,color,size,tool} 坐标为 0-1000 x 0-700 逻辑坐标
        if (room.state === 'playing' && id === room.drawerId) {
          broadcast(room, { t: 'stroke', ...msg }, id);
        }
        break;

      case 'clear':
        if (room.state === 'playing' && id === room.drawerId) broadcast(room, { t: 'clear' }, id);
        break;

      case 'guess': {
        if (room.state !== 'playing' || id === room.drawerId) return;
        if (room.correctSet.has(id)) return;
        const text = norm(msg.text).slice(0, 20);
        if (!text) return;
        if (text === norm(room.word.answer)) {
          room.correctSet.add(id);
          const timeLeft = Math.max(0, Math.round((room.endsAt - Date.now()) / 1000));
          const gain = 10 + Math.ceil(timeLeft / 10) * 2;
          me.score += gain;
          const drawer = room.players.get(room.drawerId);
          if (drawer) drawer.score += 5;
          broadcast(room, { t: 'correct', playerId: id, name: me.name, gain, timeLeft, players: playerList(room) });
          const guessers = [...room.players.keys()].filter(pid => pid !== room.drawerId);
          if (guessers.every(pid => room.correctSet.has(pid))) endRound(room, 'allCorrect');
        } else {
          broadcast(room, { t: 'chat', name: me.name, text: msg.text.slice(0, 30) });
        }
        break;
      }

      case 'again':
        if (id === room.hostId && room.state === 'over') { room.state = 'lobby'; broadcastPlayers(room); }
        break;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    const me = room.players.get(id);
    if (!me) return;
    room.players.delete(id);
    broadcast(room, { t: 'chat', sys: true, text: `${me.name} 走了` });
    if (room.players.size === 0) {
      clearTimeout(room.timer); clearTimeout(room.hintTimer);
      rooms.delete(room.code);
      return;
    }
    if (room.hostId === id) room.hostId = room.players.keys().next().value;
    // 画手掉线：直接结束本轮
    if (room.state === 'playing' && room.drawerId === id) {
      broadcastPlayers(room);
      endRound(room, 'drawerLeft');
      return;
    }
    broadcastPlayers(room);
  });
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces();
  let lan = 'localhost';
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) { lan = n.address; break; }
    }
  }
  console.log(`招远方言你画我猜 已启动:`);
  console.log(`  本机: http://localhost:${PORT}`);
  console.log(`  局域网(朋友连同一WiFi进这个): http://${lan}:${PORT}`);
});
