const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const app = express();

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4230;
const IS_PROD = process.env.NODE_ENV === "production";
const TILES_FILE = process.env.TILES_FILE || path.join(__dirname, "tiles.json");

// World is 10000x10000 px with 80px cells (see script.js) -> 125 x 125 cells
const CELL_PX = 80;
const GRID_COLS = 125;
const GRID_ROWS = 125;

const TILING_TYPES = new Set(["squareOctagon", "rhombitrihexagonal"]);
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ── Server: HTTPS on your own computer, plain HTTP on the real server ─────────
// On the real server nginx handles HTTPS/ports, so Node just speaks HTTP.
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
  maxHttpBufferSize: 10 * 1024, // messages here are tiny; refuse big ones
});

// ── Tiles persistence ─────────────────────────────────────────────────────────
let tiles = [];

function loadTiles() {
  if (!fs.existsSync(TILES_FILE)) {
    fs.writeFileSync(TILES_FILE, "[]", "utf8");
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(TILES_FILE, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("tiles file is not a list");
    tiles = parsed;
  } catch (e) {
    // Don't throw the data away: keep the broken file for inspection, start fresh
    const broken = `${TILES_FILE}.corrupt-${Date.now()}`;
    console.warn(`Could not read tiles file (${e.message}). Saved as ${broken}`);
    try {
      fs.renameSync(TILES_FILE, broken);
    } catch (_) {}
    tiles = [];
  }
}
loadTiles();

// Which grid cells are taken (older saved tiles only have wx/wy, so derive the cell)
const clampInt = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const cellId = (col, row) => `${col}_${row}`;
const occupied = new Set();
for (const t of tiles) {
  if (Number.isInteger(t.col) && Number.isInteger(t.row)) {
    occupied.add(cellId(t.col, t.row));
  } else if (typeof t.wx === "number" && typeof t.wy === "number") {
    const col = clampInt(Math.floor(t.wx / CELL_PX), 0, GRID_COLS - 1);
    const row = clampInt(Math.floor(t.wy / CELL_PX), 0, GRID_ROWS - 1);
    occupied.add(cellId(col, row));
  }
}

// Saving: batched (at most once per second), written safely, with a backup copy
let dirty = false;
let saveTimer = null;
let lastBackup = 0;

function saveNow() {
  if (!dirty) return;
  dirty = false;
  const tmp = `${TILES_FILE}.tmp`;
  try {
    if (fs.existsSync(TILES_FILE) && Date.now() - lastBackup > 10 * 60 * 1000) {
      fs.copyFileSync(TILES_FILE, `${TILES_FILE}.bak`);
      lastBackup = Date.now();
    }
    fs.writeFileSync(tmp, JSON.stringify(tiles), "utf8");
    fs.renameSync(tmp, TILES_FILE); // replaced in one step, never half-written
  } catch (e) {
    console.error("Could not save tiles:", e.message);
    dirty = true;
  }
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 1000);
}

function shutdown() {
  saveNow();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Helpers ───────────────────────────────────────────────────────────────────
const isObj = (v) => v !== null && typeof v === "object";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

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

// ── Static files ──────────────────────────────────────────────────────────────
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ── Socket ────────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("a user connected", socket.id);

  const tileLimiter = makeLimiter(20, 60 * 1000); // 20 new tiles per minute
  const liveLimiter = makeLimiter(200, 1000); // touch/ripple events per second

  // Send all saved tiles to the new client
  socket.emit("historic-tiles", tiles);

  // Client placed a new tile
  socket.on("new-tile", (tile) => {
    if (!tileLimiter()) return;

    if (
      !isObj(tile) ||
      !Number.isInteger(tile.col) ||
      !Number.isInteger(tile.row) ||
      tile.col < 0 ||
      tile.col >= GRID_COLS ||
      tile.row < 0 ||
      tile.row >= GRID_ROWS ||
      !isNum(tile.theta) ||
      Math.abs(tile.theta) > 100 ||
      !TILING_TYPES.has(tile.tiling) ||
      typeof tile.mainColor !== "string" ||
      !COLOR_RE.test(tile.mainColor)
    ) {
      console.warn("Rejected malformed tile");
      return;
    }

    // First come, first served: a taken cell can't be replaced
    const key = cellId(tile.col, tile.row);
    if (occupied.has(key)) return;
    occupied.add(key);

    const record = {
      col: tile.col,
      row: tile.row,
      theta: tile.theta,
      tiling: tile.tiling,
      mainColor: tile.mainColor,
      ts: Date.now(),
    };
    tiles.push(record);
    scheduleSave();

    // Broadcast to all other clients
    socket.broadcast.emit("new-tile", record);
  });

  // Validates live-sync data. Each connection may only act as one userId.
  function liveUser(data) {
    if (!isObj(data)) return null;
    const { userId } = data;
    if (typeof userId !== "string" || userId.length === 0 || userId.length > 40) {
      return null;
    }
    if (!socket.data.userId) socket.data.userId = userId;
    return socket.data.userId === userId ? userId : null;
  }

  // Touch position sync
  socket.on("user-touch-move", (data) => {
    if (!liveLimiter()) return;
    const userId = liveUser(data);
    if (!userId || !isNum(data.x) || !isNum(data.y)) return;
    socket.broadcast.emit("user-touch-move", { userId, x: data.x, y: data.y });
  });

  socket.on("user-touch-end", (data) => {
    if (!liveLimiter()) return;
    const userId = liveUser(data);
    if (!userId) return;
    socket.broadcast.emit("user-touch-end", { userId });
  });

  socket.on("user-ripple", (data) => {
    if (!liveLimiter()) return;
    const userId = liveUser(data);
    if (!userId || !isNum(data.x) || !isNum(data.y)) return;
    // Broadcast ripple to all OTHER clients
    socket.broadcast.emit("user-ripple", { x: data.x, y: data.y });
  });

  socket.on("disconnect", () => {
    console.log("someone disconnected", socket.id);
    if (socket.data.userId) {
      io.emit("user-touch-end", { userId: socket.data.userId });
    }
  });
});

server.listen(PORT, () => {
  console.log(
    `${useLocalHTTPS ? "HTTPS" : "HTTP"} server started at port`,
    PORT,
  );
});
