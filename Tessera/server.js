const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = express();

// ---------- CONFIG ----------
const PORT = process.env.PORT || 3000;
const TOTAL_TILES = 84;
const TILE_SIZE = 200;
const COLS = 12;
const ROWS = 7;

// Where images live. Override with TILES_DIR to point at a persistent volume.
const TILES_DIR = process.env.TILES_DIR || path.join(__dirname, 'public', 'tiles');
// Old versions of overwritten tiles go here (NOT publicly served).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, 'backups');
const BACKUPS_PER_TILE = 5;

// Delete is disabled unless you set ADMIN_TOKEN in the server environment.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;   // decoded JPEG size limit
const RATE_LIMIT_MAX = 60;                 // max saves ...
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000; // ... per IP per 10 minutes

// Running behind nginx: trust its X-Forwarded-For header so req.ip is the real visitor.
app.set('trust proxy', 1);

// ---------- MIDDLEWARE ----------
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
});
// Tiles first, so a custom TILES_DIR takes priority over public/tiles
app.use('/tiles', express.static(TILES_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '10mb' }));

// ---------- HELPERS ----------

// Returns an integer 1..TOTAL_TILES, or null if the id is not valid.
function parseTileId(raw) {
    if (!/^\d{1,3}$/.test(String(raw))) return null;
    const id = parseInt(raw, 10);
    return id >= 1 && id <= TOTAL_TILES ? id : null;
}

// Decodes and validates a base64 JPEG data URL. Returns { buffer } or { error }.
function decodeJpegDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string') return { error: 'Image must be a string' };

    const prefix = 'data:image/jpeg;base64,';
    if (!dataUrl.startsWith(prefix)) return { error: 'Image must be a JPEG data URL' };

    const b64 = dataUrl.slice(prefix.length);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: 'Image data is not valid base64' };

    const buffer = Buffer.from(b64, 'base64');
    if (buffer.length < 100) return { error: 'Image is too small' };
    if (buffer.length > MAX_IMAGE_BYTES) return { error: 'Image is too large' };

    // Real JPEG files start with FF D8 FF
    if (buffer[0] !== 0xFF || buffer[1] !== 0xD8 || buffer[2] !== 0xFF) {
        return { error: 'File is not a real JPEG' };
    }
    return { buffer };
}

// Simple in-memory rate limiter (per IP)
const saveHits = new Map();
function rateLimitSaves(req, res, next) {
    const now = Date.now();
    const hits = (saveHits.get(req.ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
    if (hits.length >= RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many saves. Please wait a few minutes.' });
    }
    hits.push(now);
    saveHits.set(req.ip, hits);
    next();
}
// Clean up old entries so the map doesn't grow forever
setInterval(() => {
    const now = Date.now();
    for (const [ip, hits] of saveHits) {
        if (hits.every(t => now - t >= RATE_LIMIT_WINDOW_MS)) saveHits.delete(ip);
    }
}, 60 * 1000).unref();

// Admin check for destructive actions
function requireAdmin(req, res, next) {
    if (!ADMIN_TOKEN) {
        return res.status(403).json({ error: 'Deleting tiles is disabled on this server' });
    }
    const given = Buffer.from(String(req.get('x-admin-token') || ''));
    const expected = Buffer.from(ADMIN_TOKEN);
    const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
    if (!ok) return res.status(401).json({ error: 'Not authorized' });
    next();
}

function ensureDirectory(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
}

// Get file modification time
function getFileModifiedTime(tileId) {
    const filepath = path.join(TILES_DIR, `tile-${tileId}.jpg`);
    if (fs.existsSync(filepath)) {
        return fs.statSync(filepath).mtime.toISOString();
    }
    return null;
}

// Get all tiles (existing images + empty slots)
function getExistingTiles() {
    ensureDirectory(TILES_DIR);

    const tiles = [];
    const files = fs.readdirSync(TILES_DIR);

    files.forEach(filename => {
        const match = filename.match(/^tile-(\d+)\.(jpg|jpeg|png)$/);
        if (!match) return;
        const tileId = parseInt(match[1], 10);
        if (tileId < 1 || tileId > TOTAL_TILES) return; // ignore stray files

        const row = Math.floor((tileId - 1) / COLS);
        const col = (tileId - 1) % COLS;

        tiles.push({
            id: tileId,
            image: filename,
            url: `/tiles/${filename}`,
            position: { row, col },
            colors: ['#660033'],  // Default
            symmetry: 6,          // Default
            lastModified: getFileModifiedTime(tileId)
        });
    });

    // Add empty slots for missing tiles
    for (let i = 1; i <= TOTAL_TILES; i++) {
        if (!tiles.find(t => t.id === i)) {
            tiles.push({
                id: i,
                image: null,
                url: null,
                position: { row: Math.floor((i - 1) / COLS), col: (i - 1) % COLS },
                colors: ['#660033'],
                symmetry: 6,
                lastModified: null
            });
        }
    }

    tiles.sort((a, b) => a.id - b.id);
    return tiles;
}

// Copy the current image into the backup folder before it is replaced/deleted
function backupTile(tileId) {
    const filepath = path.join(TILES_DIR, `tile-${tileId}.jpg`);
    if (!fs.existsSync(filepath)) return;

    ensureDirectory(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(filepath, path.join(BACKUP_DIR, `tile-${tileId}-${stamp}.jpg`));

    // Keep only the newest few backups for this tile
    const prefix = `tile-${tileId}-`;
    const old = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith(prefix) && f.endsWith('.jpg'))
        .sort()          // timestamps sort oldest -> newest
        .slice(0, -BACKUPS_PER_TILE);
    old.forEach(f => fs.unlinkSync(path.join(BACKUP_DIR, f)));
}

// Save tile image (backup old one, then write atomically)
function saveTileImage(tileId, buffer) {
    ensureDirectory(TILES_DIR);

    const filename = `tile-${tileId}.jpg`;
    const filepath = path.join(TILES_DIR, filename);
    const tmpPath = path.join(TILES_DIR, `.tmp-${tileId}-${crypto.randomBytes(6).toString('hex')}`);

    try {
        backupTile(tileId);
        fs.writeFileSync(tmpPath, buffer);
        fs.renameSync(tmpPath, filepath); // replace in one step, never a half-written file
        console.log(`Saved tile ${tileId} as: ${filename}`);
        return { success: true, filename, url: `/tiles/${filename}`, tileId };
    } catch (error) {
        console.error(`Error saving tile ${tileId}:`, error);
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        return { success: false, error: error.message };
    }
}

// Delete tile image (backup first so it can be restored)
function deleteTileImage(tileId) {
    const filepath = path.join(TILES_DIR, `tile-${tileId}.jpg`);
    if (!fs.existsSync(filepath)) return false;

    backupTile(tileId);
    fs.unlinkSync(filepath);
    console.log(`Deleted tile ${tileId} image`);
    return true;
}

// ---------- API ROUTES ----------

// GET all tiles
app.get('/api/tiles', (req, res) => {
    res.json({
        tiles: getExistingTiles(),
        gridConfig: {
            totalTiles: TOTAL_TILES,
            cols: COLS,
            rows: ROWS,
            tileSize: TILE_SIZE
        }
    });
});

// GET specific tile
app.get('/api/tiles/:id', (req, res) => {
    const tileId = parseTileId(req.params.id);
    if (tileId === null) {
        return res.status(400).json({ error: `Tile id must be a number from 1 to ${TOTAL_TILES}` });
    }
    const tile = getExistingTiles().find(t => t.id === tileId);
    if (tile) {
        res.json(tile);
    } else {
        res.status(404).json({ error: 'Tile not found' });
    }
});

// POST - Save tile as image file
app.post('/api/tiles/:id', rateLimitSaves, (req, res) => {
    const tileId = parseTileId(req.params.id);
    if (tileId === null) {
        return res.status(400).json({ error: `Tile id must be a number from 1 to ${TOTAL_TILES}` });
    }

    const { image } = req.body || {};
    if (!image) {
        return res.status(400).json({ error: 'No image data provided' });
    }

    const decoded = decodeJpegDataUrl(image);
    if (decoded.error) {
        return res.status(400).json({ error: decoded.error });
    }

    const result = saveTileImage(tileId, decoded.buffer);
    if (result.success) {
        res.json({
            success: true,
            message: 'Tile saved as image file',
            tileId,
            url: result.url,
            filename: result.filename
        });
    } else {
        res.status(500).json({ error: 'Failed to save image' });
    }
});

// DELETE - admin only
app.delete('/api/tiles/:id', requireAdmin, (req, res) => {
    const tileId = parseTileId(req.params.id);
    if (tileId === null) {
        return res.status(400).json({ error: `Tile id must be a number from 1 to ${TOTAL_TILES}` });
    }
    if (deleteTileImage(tileId)) {
        res.json({ success: true, message: `Tile ${tileId} image deleted` });
    } else {
        res.status(404).json({ error: `Tile ${tileId} image not found` });
    }
});

// ---------- PAGES ----------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/gallery', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/tile/:id', (req, res) => {
    if (parseTileId(req.params.id) === null) return res.redirect('/gallery');
    res.sendFile(path.join(__dirname, 'public', 'tile.html'));
});

// ---------- ERROR HANDLING ----------
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Image is too large' });
    }
    if (err.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid request body' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
});

ensureDirectory(TILES_DIR);

app.listen(PORT, () => {
    console.log(`Tessera running on port ${PORT}`);
    if (!ADMIN_TOKEN) console.log('ADMIN_TOKEN not set: tile deletion is disabled.');
});
