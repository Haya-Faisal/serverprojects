const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4230;
const IS_PROD = process.env.NODE_ENV === "production";
// A screen may only report "food expired" after the food has existed this long
// (the browser expires it after 20s)
const FOOD_EXPIRE_MIN_MS = Number(process.env.FOOD_EXPIRE_MIN_MS) || 15000;

const COLS = 18; // canvas is 360px wide, 20px cells
const ROWS = 25; // canvas is 500px tall, 20px cells
const CELL = 20;
const WIN_SCORE = 5;
const SIDES = new Set(["left", "right", "top", "bottom"]);

// ── Server: local HTTPS on your own computer, plain HTTP on the real server ───
// On the real server nginx provides HTTPS, so Node just speaks HTTP behind it.
const KEY_FILE = path.join(__dirname, "keys-for-local-https", "localhost-key.pem");
const CERT_FILE = path.join(__dirname, "keys-for-local-https", "localhost.pem");
const useLocalHTTPS = !IS_PROD && fs.existsSync(KEY_FILE) && fs.existsSync(CERT_FILE);

const server = useLocalHTTPS
  ? https.createServer(
      { key: fs.readFileSync(KEY_FILE), cert: fs.readFileSync(CERT_FILE) },
      app,
    )
  : http.createServer(app);

const { Server } = require("socket.io");
const io = new Server(server, {
  maxHttpBufferSize: 10 * 1024, // messages are tiny; refuse big ones
});

app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ───────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === "object";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Allow at most `max` events per `windowMs` for one socket
function makeLimiter(max, windowMs) {
  let count = 0;
  let windowStart = Date.now();
  return () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      count = 0;
    }
    count += 1;
    return count <= max;
  };
}

// ── Game state ────────────────────────────────────────────────────────────────
let screen1 = null; // socket id of player 1
let screen2 = null; // socket id of player 2
let gameScore = 0; // the server keeps the score, not the phones
let levelChanged = false;
let currentFood = null; // { screen, x, y, at }

function resetGameState() {
  gameScore = 0;
  levelChanged = false; // (this was never reset before, so level 2 only ever ran once)
  currentFood = null;
}

// The server decides which screen gets the food and where
function decideFood() {
  const screen = Math.random() > 0.5 ? 2 : 1;
  const x = Math.floor(Math.random() * COLS) * CELL;
  const y = Math.floor(Math.random() * ROWS) * CELL;
  return { screen, x, y };
}

function spawnFood() {
  const f = decideFood();
  currentFood = { ...f, at: Date.now() };
  const here = f.screen === 1 ? screen1 : screen2;
  const other = f.screen === 1 ? screen2 : screen1;
  if (here) io.to(here).emit("food-pos", { x: f.x, y: f.y });
  // explicitly clear the other screen's food
  if (other) io.to(other).emit("food-cleared");
}

// ── Sockets ───────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("screen connected:", socket.id);

  // Assign role
  let role = null;
  if (!screen1) {
    screen1 = socket.id;
    role = 1;
  } else if (!screen2) {
    screen2 = socket.id;
    role = 2;
  } else {
    // both screens taken
    socket.emit("lobby-full");
    socket.disconnect();
    return;
  }
  socket.emit("your-role", role);
  console.log(`role ${role} assigned`);

  const otherId = () => (role === 1 ? screen2 : screen1);

  // Both players here: start a fresh game
  if (screen1 && screen2) {
    resetGameState();
    socket.emit("all-here");
    io.to(screen1).emit("start-snake");
    io.to(screen2).emit("level1");
    spawnFood();
    console.log("both screens ready");
  }

  const gameLimit = makeLimiter(20, 1000); // game events per second
  const tiltLimit = makeLimiter(120, 1000); // tilt updates per second

  // Snake leaves this screen and enters the other one
  socket.on("snake-exited", (data) => {
    if (!gameLimit() || !isObj(data)) return;
    const { side, x, y, snakelenght } = data;
    if (
      !SIDES.has(side) ||
      !isNum(x) ||
      !isNum(y) ||
      Math.abs(x) > 2000 ||
      Math.abs(y) > 2000 ||
      !Number.isInteger(snakelenght) ||
      snakelenght < 1 ||
      snakelenght > 1000
    ) {
      return;
    }
    const other = otherId();
    if (other) {
      io.to(other).emit("snake-entering", { from: side, x, y, snakelenght });
    } else {
      socket.emit("snake-bounce", { side });
    }
  });

  // Food eaten: only the screen that actually has the food can eat it
  socket.on("food-eaten", () => {
    if (!gameLimit()) return;
    if (!currentFood || currentFood.screen !== role) return;

    gameScore += 1;
    if (gameScore >= WIN_SCORE && !levelChanged) {
      levelChanged = true;
      console.log("emitting level-change!");
      io.emit("level-change", { level: 2 });
    }
    const other = otherId();
    if (other) io.to(other).emit("score-update", { score: gameScore });

    spawnFood();
  });

  // Food timed out on the screen that had it
  socket.on("food-expired", () => {
    if (!gameLimit()) return;
    if (!currentFood || currentFood.screen !== role) return;
    if (Date.now() - currentFood.at < FOOD_EXPIRE_MIN_MS) return;
    spawnFood();
  });

  // Tilt data from the controlling phone goes to the other phone
  socket.on("tilt", (data) => {
    if (!tiltLimit() || !isObj(data)) return;
    if (!isNum(data.gamma) || !isNum(data.beta)) return;
    const other = otherId();
    if (other) {
      io.to(other).emit("tilt", {
        gamma: clamp(data.gamma, -180, 180),
        beta: clamp(data.beta, -180, 180),
      });
    }
  });

  socket.on("disconnect", () => {
    if (screen1 === socket.id) screen1 = null;
    if (screen2 === socket.id) screen2 = null;
    resetGameState(); // the game can't continue with one player
    io.emit("other-disconnected");
    console.log("disconnected:", socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`${useLocalHTTPS ? "HTTPS" : "HTTP"} Server started at port`, PORT);
});
