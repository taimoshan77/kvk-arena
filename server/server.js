// ============================================
// K vs K — 1v1 Arena Server
// ============================================
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files
app.use(express.static(path.join(__dirname, "../public")));
app.use("/assets", express.static(path.join(__dirname, "../assets")));

// ============================================
// GAME CONFIG (server authority)
// ============================================
const CFG = {
    ARENA_W: 800,
    ARENA_H: 600,
    PLAYER_SPEED: 200,       // px/s
    PLAYER_HP: 100,
    PLAYER_RADIUS: 20,
    BULLET_SPEED: 400,       // px/s
    BULLET_RADIUS: 5,
    BULLET_DAMAGE: 10,
    FIRE_COOLDOWN: 333,      // ms (3 shots/s)
    DASH_DISTANCE: 150,
    DASH_COOLDOWN: 5000,     // ms
    POWERUP_INTERVAL_MIN: 10000,
    POWERUP_INTERVAL_MAX: 20000,
    POWERUP_RADIUS: 15,
    POWERUP_DURATION: 8000,
    TICK_RATE: 20,           // Hz
};

// ============================================
// ROOMS & MATCHMAKING
// ============================================
const rooms = new Map();
const matchQueue = [];

function generateCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return rooms.has(code) ? generateCode() : code;
}

function createRoom(p1Socket, p2Socket) {
    const code = generateCode();
    const room = {
        code,
        players: [
            createPlayer(0, p1Socket),
            createPlayer(1, p2Socket),
        ],
        bullets: [],
        powerups: [],
        nextBulletId: 0,
        state: "playing",
        tickInterval: null,
        powerupTimer: randomPowerupTime(),
        lastTick: Date.now(),
    };
    rooms.set(code, room);

    // Assign room refs
    p1Socket._room = room;
    p1Socket._playerIndex = 0;
    p2Socket._room = room;
    p2Socket._playerIndex = 1;

    // Notify both players
    p1Socket.emit("game_start", { index: 0, code, config: CFG });
    p2Socket.emit("game_start", { index: 1, code, config: CFG });

    // Start tick loop
    room.lastTick = Date.now();
    room.tickInterval = setInterval(() => tickRoom(room), 1000 / CFG.TICK_RATE);

    console.log(`Room ${code}: game started`);
    return room;
}

function createPlayer(index, socket) {
    const spawnX = index === 0 ? 200 : 600;
    const spawnY = index === 0 ? 450 : 150;
    return {
        socket,
        index,
        x: spawnX,
        y: spawnY,
        vx: 0,
        vy: 0,
        hp: CFG.PLAYER_HP,
        lastFireTime: 0,
        lastDashTime: -CFG.DASH_COOLDOWN,
        dashCooldown: 0,
        powerup: null,
        powerupTimer: 0,
        inputSeq: 0,
        alive: true,
    };
}

function randomPowerupTime() {
    return CFG.POWERUP_INTERVAL_MIN + Math.random() * (CFG.POWERUP_INTERVAL_MAX - CFG.POWERUP_INTERVAL_MIN);
}

function destroyRoom(room) {
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(room.code);
    console.log(`Room ${room.code}: cleaned up`);
}

// ============================================
// SERVER TICK
// ============================================
function tickRoom(room) {
    if (room.state !== "playing") return;
    const now = Date.now();
    const dt = (now - room.lastTick) / 1000; // seconds
    room.lastTick = now;

    // Update players
    for (const p of room.players) {
        if (!p.alive) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.x = clamp(p.x, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
        p.y = clamp(p.y, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);

        // Powerup timer
        if (p.powerup) {
            p.powerupTimer -= dt * 1000;
            if (p.powerupTimer <= 0) {
                p.powerup = null;
                p.powerupTimer = 0;
            }
        }
    }

    // Update bullets
    for (let i = room.bullets.length - 1; i >= 0; i--) {
        const b = room.bullets[i];
        b.x += b.vx * dt;
        b.y += b.vy * dt;

        // Out of bounds
        if (b.x < -10 || b.x > CFG.ARENA_W + 10 || b.y < -10 || b.y > CFG.ARENA_H + 10) {
            room.bullets.splice(i, 1);
            continue;
        }

        // Hit detection against opponent
        const target = room.players[1 - b.owner];
        if (target.alive) {
            const dx = b.x - target.x;
            const dy = b.y - target.y;
            if (dx * dx + dy * dy < (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS) * (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS)) {
                const damage = b.damage || CFG.BULLET_DAMAGE;
                target.hp -= damage;
                room.bullets.splice(i, 1);

                // Notify hit
                for (const p of room.players) {
                    p.socket.emit("player_hit", {
                        target: target.index,
                        hp: target.hp,
                        damage,
                    });
                }

                // Check death
                if (target.hp <= 0) {
                    target.hp = 0;
                    target.alive = false;
                    room.state = "done";
                    const winner = b.owner;
                    for (const p of room.players) {
                        p.socket.emit("game_over", { winner, loser: target.index });
                    }
                    clearInterval(room.tickInterval);
                    room.tickInterval = null;
                    console.log(`Room ${room.code}: Player ${winner + 1} wins`);
                    return;
                }
            }
        }
    }

    // Powerup spawning
    room.powerupTimer -= dt * 1000;
    if (room.powerupTimer <= 0) {
        room.powerupTimer = randomPowerupTime();
        const types = ["speed", "rapid", "health"];
        const type = types[Math.floor(Math.random() * types.length)];
        const powerup = {
            id: Date.now(),
            type,
            x: 50 + Math.random() * (CFG.ARENA_W - 100),
            y: 50 + Math.random() * (CFG.ARENA_H - 100),
        };
        room.powerups.push(powerup);
        for (const p of room.players) {
            p.socket.emit("powerup_spawn", powerup);
        }
    }

    // Powerup pickup
    for (let i = room.powerups.length - 1; i >= 0; i--) {
        const pu = room.powerups[i];
        for (const p of room.players) {
            if (!p.alive) continue;
            const dx = pu.x - p.x;
            const dy = pu.y - p.y;
            if (dx * dx + dy * dy < (CFG.POWERUP_RADIUS + CFG.PLAYER_RADIUS) * (CFG.POWERUP_RADIUS + CFG.PLAYER_RADIUS)) {
                // Apply powerup
                if (pu.type === "health") {
                    p.hp = Math.min(CFG.PLAYER_HP, p.hp + 30);
                } else {
                    p.powerup = pu.type;
                    p.powerupTimer = CFG.POWERUP_DURATION;
                }
                room.powerups.splice(i, 1);
                for (const pl of room.players) {
                    pl.socket.emit("powerup_pickup", {
                        id: pu.id,
                        player: p.index,
                        type: pu.type,
                        hp: p.index === pl.index ? p.hp : undefined,
                    });
                }
                break;
            }
        }
    }

    // Broadcast game state
    const state = {
        players: room.players.map(p => ({
            x: p.x,
            y: p.y,
            hp: p.hp,
            alive: p.alive,
            powerup: p.powerup,
            dashCooldown: Math.max(0, CFG.DASH_COOLDOWN - (now - p.lastDashTime)),
        })),
        bullets: room.bullets.map(b => ({
            id: b.id,
            x: b.x,
            y: b.y,
            owner: b.owner,
        })),
    };

    for (const p of room.players) {
        p.socket.emit("game_state", state);
    }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ============================================
// SOCKET.IO EVENTS
// ============================================
io.on("connection", (socket) => {
    socket._room = null;
    socket._playerIndex = -1;

    socket.on("create_room", () => {
        const code = generateCode();
        const room = {
            code,
            players: [null, null],
            bullets: [],
            powerups: [],
            nextBulletId: 0,
            state: "waiting",
            tickInterval: null,
            powerupTimer: randomPowerupTime(),
            lastTick: Date.now(),
        };
        room.players[0] = createPlayer(0, socket);
        rooms.set(code, room);
        socket._room = room;
        socket._playerIndex = 0;
        socket.emit("room_created", { code });
        console.log(`Room ${code} created`);
    });

    socket.on("join_room", (data) => {
        const code = (data.code || "").toUpperCase();
        const room = rooms.get(code);
        if (!room) {
            socket.emit("error_msg", { message: "Room not found" });
            return;
        }
        if (room.players[1] !== null) {
            socket.emit("error_msg", { message: "Room is full" });
            return;
        }
        room.players[1] = createPlayer(1, socket);
        socket._room = room;
        socket._playerIndex = 1;

        // Start game
        room.state = "playing";
        room.lastTick = Date.now();

        room.players[0].socket.emit("game_start", { index: 0, code, config: CFG });
        socket.emit("game_start", { index: 1, code, config: CFG });

        room.tickInterval = setInterval(() => tickRoom(room), 1000 / CFG.TICK_RATE);
        console.log(`Room ${code}: player 2 joined, starting`);
    });

    socket.on("quick_match", () => {
        // Remove duplicates
        const idx = matchQueue.indexOf(socket);
        if (idx !== -1) matchQueue.splice(idx, 1);

        if (matchQueue.length > 0) {
            const opponent = matchQueue.shift();
            if (opponent.connected) {
                createRoom(opponent, socket);
            } else {
                // Opponent disconnected, re-queue
                matchQueue.push(socket);
                socket.emit("queue_status", { position: matchQueue.length });
            }
        } else {
            matchQueue.push(socket);
            socket.emit("queue_status", { position: matchQueue.length });
        }
    });

    socket.on("cancel_queue", () => {
        const idx = matchQueue.indexOf(socket);
        if (idx !== -1) matchQueue.splice(idx, 1);
    });

    socket.on("player_input", (data) => {
        const room = socket._room;
        if (!room || room.state !== "playing") return;
        const p = room.players[socket._playerIndex];
        if (!p || !p.alive) return;

        // Apply movement velocity
        let speed = CFG.PLAYER_SPEED;
        if (p.powerup === "speed") speed *= 1.5;

        p.vx = (data.dx || 0) * speed;
        p.vy = (data.dy || 0) * speed;
        p.inputSeq = data.seq || 0;
    });

    socket.on("player_shoot", (data) => {
        const room = socket._room;
        if (!room || room.state !== "playing") return;
        const p = room.players[socket._playerIndex];
        if (!p || !p.alive) return;

        const now = Date.now();
        let cooldown = CFG.FIRE_COOLDOWN;
        if (p.powerup === "rapid") cooldown *= 0.5;

        if (now - p.lastFireTime < cooldown) return;
        p.lastFireTime = now;

        // Direction from data
        const angle = data.angle || 0;
        const vx = Math.cos(angle) * CFG.BULLET_SPEED;
        const vy = Math.sin(angle) * CFG.BULLET_SPEED;

        const bullet = {
            id: room.nextBulletId++,
            x: p.x,
            y: p.y,
            vx,
            vy,
            owner: p.index,
            damage: CFG.BULLET_DAMAGE,
        };
        room.bullets.push(bullet);
    });

    socket.on("player_ability", () => {
        const room = socket._room;
        if (!room || room.state !== "playing") return;
        const p = room.players[socket._playerIndex];
        if (!p || !p.alive) return;

        const now = Date.now();
        if (now - p.lastDashTime < CFG.DASH_COOLDOWN) return;
        p.lastDashTime = now;

        // Dash in current movement direction
        const mag = Math.hypot(p.vx, p.vy);
        if (mag > 0) {
            const nx = p.vx / mag;
            const ny = p.vy / mag;
            p.x += nx * CFG.DASH_DISTANCE;
            p.y += ny * CFG.DASH_DISTANCE;
            p.x = clamp(p.x, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
            p.y = clamp(p.y, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);
        }

        // Notify dash
        for (const pl of room.players) {
            pl.socket.emit("player_dash", { player: p.index, x: p.x, y: p.y });
        }
    });

    socket.on("restart_request", () => {
        const room = socket._room;
        if (!room || room.state !== "done") return;
        const p = room.players[socket._playerIndex];
        p._wantsRestart = true;

        // Check if both want restart
        if (room.players[0]._wantsRestart && room.players[1]._wantsRestart) {
            // Reset game
            room.state = "playing";
            room.bullets = [];
            room.powerups = [];
            room.powerupTimer = randomPowerupTime();
            room.lastTick = Date.now();

            for (let i = 0; i < 2; i++) {
                const pl = room.players[i];
                pl.x = i === 0 ? 200 : 600;
                pl.y = i === 0 ? 450 : 150;
                pl.vx = 0;
                pl.vy = 0;
                pl.hp = CFG.PLAYER_HP;
                pl.alive = true;
                pl.lastFireTime = 0;
                pl.lastDashTime = -CFG.DASH_COOLDOWN;
                pl.powerup = null;
                pl.powerupTimer = 0;
                pl._wantsRestart = false;
                pl.socket.emit("game_start", { index: i, code: room.code, config: CFG });
            }

            room.tickInterval = setInterval(() => tickRoom(room), 1000 / CFG.TICK_RATE);
            console.log(`Room ${room.code}: restarted`);
        } else {
            // Notify waiting
            const other = room.players[1 - socket._playerIndex];
            other.socket.emit("opponent_wants_restart");
        }
    });

    socket.on("disconnect", () => {
        // Remove from match queue
        const qIdx = matchQueue.indexOf(socket);
        if (qIdx !== -1) matchQueue.splice(qIdx, 1);

        const room = socket._room;
        if (!room) return;

        const idx = socket._playerIndex;
        room.players[idx] = null;

        // Notify opponent
        const other = room.players[1 - idx];
        if (other && other.socket) {
            other.socket.emit("opponent_disconnected");
        }

        // Clean up room if both gone or game was waiting
        if (room.players.every(p => p === null) || room.state === "waiting") {
            destroyRoom(room);
        } else if (room.state === "playing") {
            room.state = "done";
            if (room.tickInterval) clearInterval(room.tickInterval);
            room.tickInterval = null;
        }
    });
});

server.listen(PORT, () => {
    console.log(`K vs K server running on http://localhost:${PORT}`);
});
