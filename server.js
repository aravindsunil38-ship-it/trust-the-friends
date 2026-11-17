const express = require("express"), http = require("http"), { Server } = require("socket.io");
const app = express(), server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });
app.use(express.static("public"));

const ROUNDS = 10, MIN_PLAYERS = 3; // set MIN_PLAYERS to 6 for real games
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
const rooms = {};
const pub = (r) => r.players.map(({ id, name, score }) => ({ id, name, score }));
const sendPlayers = (c) => io.to(c).emit("players", { list: pub(rooms[c]), host: rooms[c].host });
const find = (r, id) => r.players.find((p) => p.id === id);
const nm = (r, id) => (find(r, id) || { name: "(left)" }).name;
const counts = (r, votes) => { const o = {}; r.players.forEach((p) => (o[p.id] = 0)); Object.values(votes).forEach((t) => o[t] !== undefined && o[t]++); return o; };

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
  r.players.forEach((p) => g.hist.forEach((h, i) => {
    const V = Object.keys(h.votes).filter((v) => h.votes[v] === p.id && find(r, v));
    const G = g.guesses[p.id][i] || [];
    G.forEach((id) => {
      if (V.includes(id)) p.score += 1;
      else if (find(r, id)) hits.push({ hitter: nm(r, id), victim: p.name, q: h.q, why: "named wrongly" });
    });
    V.filter((v) => !G.includes(v)).forEach((v) => hits.push({ hitter: nm(r, v), victim: p.name, q: h.q, why: "was missed" }));
  }));
  g.phase = "guessDone";
  io.to(c).emit("guessResults", { hits, players: pub(r) });
}
function startMimic(c) {
  const r = rooms[c], g = r.game, ps = r.players;
  const a = ps[rnd(ps.length)], others = ps.filter((p) => p !== a), t = others[rnd(others.length)];
  Object.assign(g, { phase: "mimic", mimicker: a.id, target: t.id, mv: {} });
  io.to(c).emit("info", "A secret mimic is coming. Stay quiet and listen!");
  const d = r.dialogues[t.id];
  io.to(a.id).emit("mimicTask", { target: t.name, audio: d.audio, mime: d.mime });
}
function scoreMimic(c) {
  const r = rooms[c], g = r.game, lines = [];
  const mk = find(r, g.mimicker), tg = find(r, g.target);
  r.players.filter((p) => p.id !== g.mimicker).forEach((p) => {
    const a = g.mv[p.id];
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
  io.to(c).emit("mimicResult", { mimicker: mk ? mk.name : "(left)", target: tg ? tg.name : "(left)", lines, players: pub(r) });
}
function nextRound(c) {
  const r = rooms[c], g = r.game;
  g.round++;
  if (g.round > ROUNDS) { g.phase = "over"; r.dialogues = {}; return io.to(c).emit("over", { players: pub(r) }); }
  Object.assign(g, { qi: 0, qn: qCount(), hist: [] });
  nextQ(c);
}
function advance(c) {
  const r = rooms[c], g = r && r.game; if (!g || r.players.length < 2) return;
  const all = (o) => r.players.every((p) => o[p.id]);
  if (["mimic", "mimicVote"].includes(g.phase) && !(find(r, g.mimicker) && find(r, g.target))) {
    g.phase = "mimicDone";
    return io.to(c).emit("mimicResult", { mimicker: "?", target: "?", lines: ["Mimic cancelled: a player left."], players: pub(r) });
  }
  if (g.phase === "dialogue" && all(r.dialogues)) nextQ(c);
  else if (g.phase === "voting" && all(g.votes)) endQ(c);
  else if (g.phase === "guess" && all(g.guesses)) scoreGuess(c);
  else if (g.phase === "mimicVote" && r.players.filter((p) => p.id !== g.mimicker).every((p) => g.mv[p.id])) scoreMimic(c);
}

io.on("connection", (socket) => {
  const enter = (code, name) => {
    const r = rooms[code];
    r.players.push({ id: socket.id, name: String(name).slice(0, 14) || "Player", score: 0 });
    socket.join(code); socket.roomCode = code;
    socket.emit("roomJoined", { code }); sendPlayers(code);
  };
  socket.on("createRoom", ({ name, maxPlayers }) => {
    let code; do { code = Math.random().toString(36).substring(2, 6).toUpperCase(); } while (rooms[code]);
    rooms[code] = { host: socket.id, max: maxPlayers === 10 ? 10 : 6, players: [], used: [], dialogues: {}, game: null };
    enter(code, name);
  });
  socket.on("joinRoom", ({ name, code }) => {
    const r = rooms[code];
    if (!r) return socket.emit("errorMsg", "Room not found.");
    if (r.game) return socket.emit("errorMsg", "That game has already started.");
    if (r.players.length >= r.max) return socket.emit("errorMsg", "Room is full.");
    enter(code, name);
  });
  socket.on("signal", ({ to, data }) => io.to(to).emit("signal", { from: socket.id, data }));

  socket.on("startGame", () => {
    const r = rooms[socket.roomCode];
    if (!r || r.host !== socket.id || r.game) return;
    if (r.players.length < MIN_PLAYERS) return socket.emit("errorMsg", `Need at least ${MIN_PLAYERS} players.`);
    r.game = { round: 1, qi: 0, qn: qCount(), votes: {}, hist: [], phase: "dialogue" };
    io.to(socket.roomCode).emit("dialogue");
  });
  socket.on("submitDialogue", ({ audio, mime }) => {
    const c = socket.roomCode, r = rooms[c];
    if (!r || !r.game || r.game.phase !== "dialogue" || r.dialogues[socket.id]) return;
    r.dialogues[socket.id] = { audio, mime }; advance(c);
  });
  socket.on("vote", ({ targetId }) => {
    const c = socket.roomCode, r = rooms[c], g = r && r.game;
    if (!g || g.phase !== "voting" || g.votes[socket.id] || targetId === socket.id || !find(r, targetId)) return;
    g.votes[socket.id] = targetId; advance(c);
  });
  socket.on("submitGuess", ({ guesses }) => {
    const c = socket.roomCode, r = rooms[c], g = r && r.game;
    if (!g || g.phase !== "guess" || g.guesses[socket.id] || !Array.isArray(guesses)) return;
    g.guesses[socket.id] = g.hist.map((_, i) => [...new Set(Array.isArray(guesses[i]) ? guesses[i] : [])].filter((id) => id !== socket.id));
    advance(c);
  });
  socket.on("next", () => {
    const c = socket.roomCode, r = rooms[c];
    if (!r || r.host !== socket.id || !r.game) return;
    if (r.game.phase === "guessDone") startMimic(c);
    else if (r.game.phase === "mimicDone") nextRound(c);
  });
  socket.on("submitMimic", ({ audio, mime }) => {
    const c = socket.roomCode, r = rooms[c], g = r && r.game;
    if (!g || g.phase !== "mimic" || g.mimicker !== socket.id) return;
    g.phase = "mimicVote"; g.clip = { audio, mime };
    r.players.forEach((p) => {
      if (p.id === g.mimicker) io.to(p.id).emit("info", "Your mimic is playing. Waiting for the guesses...");
      else io.to(p.id).emit("mimicVote", { audio, mime, players: pub(r), isTarget: p.id === g.target });
    });
  });
  socket.on("submitMimicVote", ({ who, whose }) => {
    const c = socket.roomCode, r = rooms[c], g = r && r.game;
    if (!g || g.phase !== "mimicVote" || g.mimicker === socket.id || g.mv[socket.id]) return;
    g.mv[socket.id] = { who, whose }; advance(c);
  });
  socket.on("disconnect", () => {
    const c = socket.roomCode, r = rooms[c]; if (!r) return;
    r.players = r.players.filter((p) => p.id !== socket.id);
    if (!r.players.length) return delete rooms[c];
    if (r.host === socket.id) r.host = r.players[0].id;
    sendPlayers(c); advance(c);
  });
});
server.listen(process.env.PORT || 3000, () => console.log("Running on http://localhost:3000"));
