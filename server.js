const express = require("express"), http = require("http"), crypto = require("crypto"), { Server } = require("socket.io");
const app = express(), server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6, pingInterval: 10000, pingTimeout: 30000 }); // patient with weak mobile signal
app.use(express.static("public"));

const ROUNDS = 10, MIN_PLAYERS = 2; // 2 is for testing. Set MIN_PLAYERS to 6 for real games
const LOBBY_GRACE = 60 * 1000, ROOM_GRACE = 10 * 60 * 1000; // lobby seat held 1 min, empty room kept 10 min
const rnd = (n) => Math.floor(Math.random() * n), qCount = () => 5 + rnd(4);
const QUESTIONS = [
  "Who would you abandon on a deserted island?", "Who would you trust with your phone password?",
  "Who would survive a zombie apocalypse the longest?", "Who is most likely to forget your birthday?",
  "Who would you pick as your partner for a heist?", "Who is the biggest drama queen?",
  "Who would you hide from if you owed them money?", "Who would get lost even with GPS?",
  "Who should give the speech at your wedding?", "Who is most likely to go viral for something silly?",
  "Who would cry first at a sad movie?", "Who would you wake up at 3 AM for help?",
  "Who is the worst driver?", "Who would sell you out for free pizza?",
  "Who is most likely to be late to their own party?", "Who would you let cut your hair?",
  "Who talks the most in a group chat?", "Who would you pick as your bodyguard?",
  "Who is most likely to become a millionaire?", "Who would you never lend money to?",
  "Who would last the shortest time in jail?", "Who is secretly the smartest?",
  "Who would you send to negotiate with an angry boss?", "Who is most likely to fall asleep at a party?",
  "Who would you trust to keep a secret?", "Who is the funniest when angry?",
  "Who would win a hot dog eating contest?", "Who is most likely to get famous and forget everyone?",
  "Who would you swap lives with for a day?", "Who is the biggest foodie?",
  "Who would panic first in a horror movie?", "Who is the best liar?",
  "Who would you pick to plan a surprise party?", "Who is most likely to adopt 10 pets?",
  "Who would you leave in charge of the group money?", "Who is the laziest?",
  "Who would run for president as a joke?", "Who has the worst taste in music?",
  "Who would you call first after winning the lottery?", "Who would get you out of trouble?",
];

/* A player now has: id (permanent, public), token (private rejoin key), socketId (changes on reconnect), online */
const rooms = {};
const pub = (r) => r.players.map(({ id, name, score, online }) => ({ id, name, score, online }));
const act = (r) => r.players.filter((p) => p.online);
const sendPlayers = (c) => io.to(c).emit("players", { list: pub(rooms[c]), host: rooms[c].host });
const find = (r, id) => r.players.find((p) => p.id === id);
const nm = (r, id) => (find(r, id) || { name: "(left)" }).name;
const counts = (r, votes) => { const o = {}; r.players.forEach((p) => (o[p.id] = 0)); Object.values(votes).forEach((t) => o[t] !== undefined && o[t]++); return o; };
const toP = (r, id, ev, d) => { const p = find(r, id); if (p && p.online) io.to(p.socketId).emit(ev, d); };
const cleanName = (n) => String(n || "").trim().replace(/\s+/g, " ").slice(0, 14);

// Keeps the host an online player. Returns true if the host changed.
function ensureHost(r) {
  const h = find(r, r.host);
  if (h && h.online) return false;
  const n = r.players.find((p) => p.online);
  if (!n) return false;
  r.host = n.id; return true;
}
// After a host change, show the result screens again so the new host gets the Continue button
function refreshHostScreen(c) {
  const r = rooms[c], g = r && r.game; if (!g) return;
  if (g.phase === "guessDone") io.to(c).emit("guessResults", { hits: g.hits, players: pub(r) });
  else if (g.phase === "mimicDone") io.to(c).emit("mimicResult", g.result);
}
// Lobby only: remove a player who stayed offline too long
function dropPlayer(c, id) {
  const r = rooms[c]; if (!r || r.game) return;
  const p = find(r, id); if (!p || p.online) return;
  r.players = r.players.filter((x) => x !== p);
  if (!r.players.length) return delete rooms[c];
  ensureHost(r); sendPlayers(c);
}

function nextQ(c) {
  const r = rooms[c], g = r.game;
  const pool = QUESTIONS.filter((q) => !r.used.includes(q));
  if (!pool.length) r.used = [];
  const list = pool.length ? pool : QUESTIONS;
  g.q = list[rnd(list.length)]; r.used.push(g.q);
  g.votes = {}; g.phase = "voting";
  io.to(c).emit("question", { round: g.round, n: g.qi + 1, total: g.qn, text: g.q, players: pub(r) });
}
function endQ(c) {
  const r = rooms[c], g = r.game;
  g.hist.push({ q: g.q, votes: g.votes }); g.qi++;
  if (g.qi < g.qn) return nextQ(c);
  g.phase = "guess"; g.guesses = {};
  io.to(c).emit("guess", { round: g.round, players: pub(r), summary: g.hist.map((h) => ({ q: h.q, counts: counts(r, h.votes) })) });
}
function scoreGuess(c) {
  const r = rooms[c], g = r.game, hits = [];
  r.players.forEach((p) => {
    const mine = g.guesses[p.id];
    if (!mine) return; // was offline and never guessed: no points, no bat hits
    g.hist.forEach((h, i) => {
      const V = Object.keys(h.votes).filter((v) => h.votes[v] === p.id && find(r, v));
      const G = mine[i] || [];
      G.forEach((id) => {
        if (V.includes(id)) p.score += 1;
        else if (find(r, id)) hits.push({ hitter: nm(r, id), victim: p.name, q: h.q, why: "named wrongly" });
      });
      V.filter((v) => !G.includes(v)).forEach((v) => hits.push({ hitter: nm(r, v), victim: p.name, q: h.q, why: "was missed" }));
    });
  });
  g.phase = "guessDone"; g.hits = hits;
  io.to(c).emit("guessResults", { hits, players: pub(r) });
}
function startMimic(c) {
  const r = rooms[c], g = r.game, on = act(r);
  const a = on[rnd(on.length)]; // the mimicker must be online
  const cands = r.players.filter((p) => p !== a && r.dialogues[p.id]); // the target must have a recorded line
  if (!cands.length) {
    g.phase = "mimicDone";
    g.result = { mimicker: "?", target: "?", lines: ["Mimic skipped: no recorded line available."], players: pub(r) };
    return io.to(c).emit("mimicResult", g.result);
  }
  const t = cands[rnd(cands.length)];
  Object.assign(g, { phase: "mimic", mimicker: a.id, target: t.id, mv: {} });
  io.to(c).emit("info", "A secret mimic is coming. Stay quiet and listen!");
  const d = r.dialogues[t.id];
  toP(r, a.id, "mimicTask", { target: t.name, audio: d.audio, mime: d.mime });
}
function scoreMimic(c) {
  const r = rooms[c], g = r.game, lines = [];
  const mk = find(r, g.mimicker), tg = find(r, g.target);
  r.players.filter((p) => p.id !== g.mimicker).forEach((p) => {
    const a = g.mv[p.id];
    if (!a) { lines.push(p.name + " was offline: no score"); return; }
    if (p.id === g.target) {
      if (a.who === g.mimicker) { p.score += 3; lines.push(p.name + " spotted the mimicker: +3"); }
      else lines.push(p.name + " guessed the wrong mimicker: +0");
      return;
    }
    const okWho = a.who === g.mimicker, okWhose = a.whose === g.target;
    p.score += (okWho ? 2 : -3) + (okWhose ? 2 : -3);
    if (okWhose && mk) mk.score += 1;
    lines.push(`${p.name}: mimicker ${okWho ? "+2" : "-3"}, voice ${okWhose ? "+2" : "-3"}`);
  });
  g.phase = "mimicDone"; g.clip = null;
  g.result = { mimicker: mk ? mk.name : "(left)", target: tg ? tg.name : "(left)", lines, players: pub(r) };
  io.to(c).emit("mimicResult", g.result);
}
function nextRound(c) {
  const r = rooms[c], g = r.game;
  g.round++;
  if (g.round > ROUNDS) { g.phase = "over"; r.dialogues = {}; return io.to(c).emit("over", { players: pub(r) }); }
  Object.assign(g, { qi: 0, qn: qCount(), hist: [] });
  nextQ(c);
}
// Moves the game on once every ONLINE player has answered. Offline players are never waited for.
function advance(c) {
  const r = rooms[c], g = r && r.game; if (!g) return;
  const on = act(r);
  if (on.length < 2) return; // paused until at least 2 players are online
  const all = (o) => on.every((p) => o[p.id]);
  const mk = find(r, g.mimicker);
  if (g.phase === "mimic" && !(mk && mk.online)) { // the mimicker dropped before sending: skip the mimic
    g.phase = "mimicDone";
    g.result = { mimicker: "?", target: "?", lines: ["Mimic cancelled: the mimicker went offline."], players: pub(r) };
    return io.to(c).emit("mimicResult", g.result);
  }
  if (g.phase === "dialogue" && all(r.dialogues)) nextQ(c);
  else if (g.phase === "voting" && all(g.votes)) endQ(c);
  else if (g.phase === "guess" && all(g.guesses)) scoreGuess(c);
  else if (g.phase === "mimicVote" && on.filter((p) => p.id !== g.mimicker).every((p) => g.mv[p.id])) scoreMimic(c);
}
// Sends a rejoining player whatever screen the game is on right now
function catchUp(r, p) {
  const g = r.game; if (!g) return;
  const to = (ev, d) => io.to(p.socketId).emit(ev, d), wait = (t) => to("info", t);
  if (g.phase === "dialogue") return r.dialogues[p.id] ? wait("Line saved. Waiting for the others...") : to("dialogue");
  if (g.phase === "voting") return g.votes[p.id] ? wait("Vote locked in. Waiting for the others...") : to("question", { round: g.round, n: g.qi + 1, total: g.qn, text: g.q, players: pub(r) });
  if (g.phase === "guess") return g.guesses[p.id] ? wait("Guesses locked. Waiting for the others...") : to("guess", { round: g.round, players: pub(r), summary: g.hist.map((h) => ({ q: h.q, counts: counts(r, h.votes) })) });
  if (g.phase === "guessDone") return to("guessResults", { hits: g.hits, players: pub(r) });
  if (g.phase === "mimic") {
    if (p.id !== g.mimicker) return wait("A secret mimic is coming. Stay quiet and listen!");
    const d = r.dialogues[g.target], t = find(r, g.target);
    return d && t ? to("mimicTask", { target: t.name, audio: d.audio, mime: d.mime }) : wait("Waiting...");
  }
  if (g.phase === "mimicVote") {
    if (p.id === g.mimicker) return wait("Your mimic is playing. Waiting for the guesses...");
    if (g.mv[p.id] || !g.clip) return wait("Answer locked. Waiting for the others...");
    return to("mimicVote", { audio: g.clip.audio, mime: g.clip.mime, players: pub(r), isTarget: p.id === g.target });
  }
  if (g.phase === "mimicDone") return to("mimicResult", g.result);
  if (g.phase === "over") return to("over", { players: pub(r) });
}

io.on("connection", (socket) => {
  // A socket counts only if it is the CURRENT socket of a registered player. Anything else is ignored.
  const who = (s) => { const r = rooms[s.roomCode], p = r && find(r, s.pid); return p && p.socketId === s.id ? { r, p } : null; };
  const enter = (code, name) => {
    const r = rooms[code];
    const p = { id: crypto.randomBytes(4).toString("hex"), token: crypto.randomUUID(), socketId: socket.id, online: true, name, score: 0 };
    r.players.push(p); if (!r.host) r.host = p.id;
    clearTimeout(r.cleanup);
    socket.join(code); socket.roomCode = code; socket.pid = p.id;
    socket.emit("roomJoined", { code, id: p.id, token: p.token, inGame: false });
    sendPlayers(code);
  };
  socket.on("createRoom", ({ name, maxPlayers } = {}) => {
    const n = cleanName(name);
    if (n.length < 2) return socket.emit("errorMsg", "Enter your name first (at least 2 characters).");
    let code; do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (rooms[code]);
    rooms[code] = { host: null, max: maxPlayers === 10 ? 10 : 6, players: [], used: [], dialogues: {}, game: null };
    enter(code, n);
  });
  socket.on("joinRoom", ({ name, code } = {}) => {
    const n = cleanName(name);
    if (n.length < 2) return socket.emit("errorMsg", "Enter your name first (at least 2 characters).");
    const r = rooms[code];
    if (!r) return socket.emit("errorMsg", "Room not found.");
    if (r.game) return socket.emit("errorMsg", "That game has already started.");
    if (r.players.length >= r.max) return socket.emit("errorMsg", "Room is full.");
    if (r.players.some((p) => p.name.toLowerCase() === n.toLowerCase())) return socket.emit("errorMsg", "That name is already taken in this room.");
    enter(code, n);
  });
  // A returning player proves who they are with their private token
  socket.on("rejoin", ({ code, token } = {}) => {
    const r = rooms[code], p = r && token && r.players.find((x) => x.token === token);
    if (!p) return socket.emit("rejoinFailed", "Could not rejoin. Join again with your name.");
    clearTimeout(p.rm); clearTimeout(r.cleanup);
    p.socketId = socket.id; p.online = true;
    socket.join(code); socket.roomCode = code; socket.pid = p.id;
    ensureHost(r);
    socket.emit("roomJoined", { code, id: p.id, token: p.token, inGame: !!r.game });
    sendPlayers(code);
    catchUp(r, p);
    advance(code);
  });
  socket.on("signal", ({ to, data }) => {
    const w = who(socket); if (!w) return;
    const t = find(w.r, to);
    if (t && t.online) io.to(t.socketId).emit("signal", { from: w.p.id, data });
  });

  socket.on("startGame", () => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, c = socket.roomCode;
    if (r.host !== p.id || r.game) return;
    if (act(r).length < MIN_PLAYERS) return socket.emit("errorMsg", `Need at least ${MIN_PLAYERS} players online.`);
    r.players.filter((x) => !x.online).forEach((x) => clearTimeout(x.rm));
    r.players = r.players.filter((x) => x.online);
    r.game = { round: 1, qi: 0, qn: qCount(), votes: {}, hist: [], phase: "dialogue" };
    sendPlayers(c);
    io.to(c).emit("dialogue");
  });
  socket.on("submitDialogue", ({ audio, mime } = {}) => {
    const w = who(socket); if (!w) return;
    const { r, p } = w;
    if (!r.game || r.game.phase !== "dialogue" || r.dialogues[p.id]) return;
    r.dialogues[p.id] = { audio, mime }; advance(socket.roomCode);
  });
  socket.on("vote", ({ targetId } = {}) => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, g = r.game;
    if (!g || g.phase !== "voting" || g.votes[p.id] || targetId === p.id || !find(r, targetId)) return;
    g.votes[p.id] = targetId; advance(socket.roomCode);
  });
  socket.on("submitGuess", ({ guesses } = {}) => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, g = r.game;
    if (!g || g.phase !== "guess" || g.guesses[p.id] || !Array.isArray(guesses)) return;
    g.guesses[p.id] = g.hist.map((_, i) => [...new Set(Array.isArray(guesses[i]) ? guesses[i] : [])].filter((id) => id !== p.id));
    advance(socket.roomCode);
  });
  socket.on("next", () => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, c = socket.roomCode;
    if (r.host !== p.id || !r.game) return;
    if (r.game.phase === "guessDone") startMimic(c);
    else if (r.game.phase === "mimicDone") nextRound(c);
  });
  socket.on("submitMimic", ({ audio, mime } = {}) => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, g = r.game;
    if (!g || g.phase !== "mimic" || g.mimicker !== p.id) return;
    g.phase = "mimicVote"; g.clip = { audio, mime };
    r.players.forEach((q) => {
      if (q.id === g.mimicker) toP(r, q.id, "info", "Your mimic is playing. Waiting for the guesses...");
      else toP(r, q.id, "mimicVote", { audio, mime, players: pub(r), isTarget: q.id === g.target });
    });
    advance(socket.roomCode);
  });
  socket.on("submitMimicVote", ({ who: pick, whose } = {}) => {
    const w = who(socket); if (!w) return;
    const { r, p } = w, g = r.game;
    if (!g || g.phase !== "mimicVote" || g.mimicker === p.id || g.mv[p.id]) return;
    g.mv[p.id] = { who: pick, whose }; advance(socket.roomCode);
  });
  socket.on("disconnect", () => {
    const w = who(socket); if (!w) return; // never registered, or an old socket of a player who already rejoined
    const { r, p } = w, c = socket.roomCode;
    p.online = false; // the player keeps their seat, name and score
    if (!r.game) p.rm = setTimeout(() => dropPlayer(c, p.id), LOBBY_GRACE);
    const hostChanged = ensureHost(r);
    if (!act(r).length) r.cleanup = setTimeout(() => delete rooms[c], ROOM_GRACE);
    sendPlayers(c);
    if (hostChanged) refreshHostScreen(c);
    advance(c); // the others may now be everyone still being waited for
  });
});
server.listen(process.env.PORT || 3000, () => console.log("Running on http://localhost:3000"));
