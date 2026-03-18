// ============================================
// K vs K — Brawl Ball Server
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
    TICK_RATE: 20,           // Hz

    // Brawl Ball config
    BALL_RADIUS: 12,
    BALL_PICKUP_RADIUS: 30,
    BALL_KICK_SPEED: 500,
    BALL_SUPER_KICK_SPEED: 700,
    BALL_FRICTION: 0.97,
    BALL_BOUNCE_DAMPING: 0.8,
    BALL_DROP_SPEED: 100,
    GOAL_WIDTH: 120,
    GOAL_DEPTH: 30,
    GOALS_TO_WIN: 2,
    MATCH_DURATION: 120000,    // 2 minutes
    OVERTIME_DURATION: 60000,  // 1 minute
    RESPAWN_TIME: 3000,        // 3 seconds
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
        nextBulletId: 0,
        state: "playing",
        tickInterval: null,
        lastTick: Date.now(),
        // Brawl Ball state
        ball: { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1 },
        score: [0, 0],
        matchTimer: CFG.MATCH_DURATION,
        overtime: false,
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
    const spawnX = index === 0 ? 150 : 650;
    const spawnY = CFG.ARENA_H / 2;
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
        inputSeq: 0,
        alive: true,
        hasBall: false,
        respawnTimer: 0,
    };
}

function destroyRoom(room) {
    if (room.tickInterval) clearInterval(room.tickInterval);
    rooms.delete(room.code);
    console.log(`Room ${room.code}: cleaned up`);
}

// ============================================
// BRAWL BALL HELPERS
// ============================================
function resetPositions(room) {
    for (let i = 0; i < 2; i++) {
        const p = room.players[i];
        p.x = i === 0 ? 150 : 650;
        p.y = CFG.ARENA_H / 2;
        p.vx = 0;
        p.vy = 0;
        p.hp = CFG.PLAYER_HP;
        p.alive = true;
        p.hasBall = false;
        p.respawnTimer = 0;
    }
    room.ball = { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1 };
    room.bullets = [];
}

function getGoalY() {
    // Goal is centered vertically
    const goalTop = (CFG.ARENA_H - CFG.GOAL_WIDTH) / 2;
    const goalBottom = goalTop + CFG.GOAL_WIDTH;
    return { top: goalTop, bottom: goalBottom, center: CFG.ARENA_H / 2 };
}

function getSpawnPos(index) {
    return { x: index === 0 ? 150 : 650, y: CFG.ARENA_H / 2 };
}

function dropBall(room, p) {
    if (room.ball.carrier !== p.index) return;
    room.ball.carrier = -1;
    p.hasBall = false;
    room.ball.x = p.x;
    room.ball.y = p.y;
    // Give it a small random velocity
    const angle = Math.random() * Math.PI * 2;
    room.ball.vx = Math.cos(angle) * CFG.BALL_DROP_SPEED;
    room.ball.vy = Math.sin(angle) * CFG.BALL_DROP_SPEED;
}

function scoreGoal(room, scoringTeam) {
    room.score[scoringTeam]++;
    console.log(`Room ${room.code}: GOAL! Player ${scoringTeam + 1} scores. Score: ${room.score[0]}-${room.score[1]}`);

    for (const p of room.players) {
        if (p) p.socket.emit("goal_scored", { scorer: scoringTeam, score: [...room.score] });
    }

    // Check win
    if (room.score[scoringTeam] >= CFG.GOALS_TO_WIN) {
        endMatch(room, scoringTeam);
        return;
    }

    // Reset positions after goal
    resetPositions(room);
}

function endMatch(room, winner) {
    room.state = "done";
    clearInterval(room.tickInterval);
    room.tickInterval = null;

    // Determine winner: winner param, or by score, or draw
    let w = winner;
    if (w === undefined || w === -1) {
        if (room.score[0] > room.score[1]) w = 0;
        else if (room.score[1] > room.score[0]) w = 1;
        else w = -1; // draw
    }

    for (const p of room.players) {
        if (p) p.socket.emit("game_over", { winner: w, score: [...room.score] });
    }
    console.log(`Room ${room.code}: Match over. Winner: ${w === -1 ? "DRAW" : "Player " + (w + 1)}. Score: ${room.score[0]}-${room.score[1]}`);
}

// ============================================
// SERVER TICK
// ============================================
function tickRoom(room) {
    if (room.state !== "playing") return;
    const now = Date.now();
    const dt = (now - room.lastTick) / 1000; // seconds
    const dtMs = now - room.lastTick;
    room.lastTick = now;

    // --- Match timer ---
    room.matchTimer -= dtMs;
    if (room.matchTimer <= 0) {
        room.matchTimer = 0;
        if (!room.overtime && room.score[0] === room.score[1]) {
            // Start overtime
            room.overtime = true;
            room.matchTimer = CFG.OVERTIME_DURATION;
            for (const p of room.players) {
                if (p) p.socket.emit("overtime_start");
            }
            console.log(`Room ${room.code}: OVERTIME`);
        } else {
            // Match ends
            endMatch(room);
            return;
        }
    }

    // --- Respawn timers ---
    for (const p of room.players) {
        if (!p.alive && p.respawnTimer > 0) {
            p.respawnTimer -= dtMs;
            if (p.respawnTimer <= 0) {
                p.respawnTimer = 0;
                p.alive = true;
                const spawn = getSpawnPos(p.index);
                p.x = spawn.x;
                p.y = spawn.y;
                p.vx = 0;
                p.vy = 0;
                p.hp = CFG.PLAYER_HP;
                for (const pl of room.players) {
                    if (pl) pl.socket.emit("player_respawn", { player: p.index, x: p.x, y: p.y });
                }
            }
        }
    }

    // --- Update players ---
    const goal = getGoalY();
    for (const p of room.players) {
        if (!p.alive) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.x = clamp(p.x, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
        p.y = clamp(p.y, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);
    }

    // --- Ball physics (when free) ---
    const ball = room.ball;
    if (ball.carrier === -1) {
        ball.x += ball.vx * dt;
        ball.y += ball.vy * dt;

        // Friction
        ball.vx *= Math.pow(CFG.BALL_FRICTION, dt * 60);
        ball.vy *= Math.pow(CFG.BALL_FRICTION, dt * 60);

        // Stop near-zero velocity
        if (Math.abs(ball.vx) < 1) ball.vx = 0;
        if (Math.abs(ball.vy) < 1) ball.vy = 0;

        // Wall bouncing — top/bottom always
        if (ball.y - CFG.BALL_RADIUS < 0) {
            ball.y = CFG.BALL_RADIUS;
            ball.vy = Math.abs(ball.vy) * CFG.BALL_BOUNCE_DAMPING;
        }
        if (ball.y + CFG.BALL_RADIUS > CFG.ARENA_H) {
            ball.y = CFG.ARENA_H - CFG.BALL_RADIUS;
            ball.vy = -Math.abs(ball.vy) * CFG.BALL_BOUNCE_DAMPING;
        }

        // Left/right walls — bounce unless in goal opening
        const inGoalOpening = ball.y > goal.top && ball.y < goal.bottom;

        if (!inGoalOpening) {
            if (ball.x - CFG.BALL_RADIUS < 0) {
                ball.x = CFG.BALL_RADIUS;
                ball.vx = Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
            if (ball.x + CFG.BALL_RADIUS > CFG.ARENA_W) {
                ball.x = CFG.ARENA_W - CFG.BALL_RADIUS;
                ball.vx = -Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
        }

        // --- Goal detection ---
        // Left goal (P0 defends): ball enters x < 0 in goal opening → P1 scores
        if (ball.x < -CFG.GOAL_DEPTH / 2 && inGoalOpening) {
            scoreGoal(room, 1);
            return;
        }
        // Right goal (P1 defends): ball enters x > ARENA_W in goal opening → P0 scores
        if (ball.x > CFG.ARENA_W + CFG.GOAL_DEPTH / 2 && inGoalOpening) {
            scoreGoal(room, 0);
            return;
        }

        // --- Ball pickup ---
        for (const p of room.players) {
            if (!p.alive) continue;
            const dx = ball.x - p.x;
            const dy = ball.y - p.y;
            if (dx * dx + dy * dy < CFG.BALL_PICKUP_RADIUS * CFG.BALL_PICKUP_RADIUS) {
                ball.carrier = p.index;
                p.hasBall = true;
                ball.vx = 0;
                ball.vy = 0;
                for (const pl of room.players) {
                    if (pl) pl.socket.emit("ball_pickup", { player: p.index });
                }
                break;
            }
        }
    } else {
        // Ball follows carrier
        const carrier = room.players[ball.carrier];
        if (carrier && carrier.alive) {
            ball.x = carrier.x;
            ball.y = carrier.y;
        }
    }

    // --- Update bullets ---
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
        if (target && target.alive) {
            const dx = b.x - target.x;
            const dy = b.y - target.y;
            if (dx * dx + dy * dy < (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS) * (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS)) {
                const damage = b.damage || CFG.BULLET_DAMAGE;
                target.hp -= damage;
                room.bullets.splice(i, 1);

                // Notify hit
                for (const p of room.players) {
                    if (p) p.socket.emit("player_hit", {
                        target: target.index,
                        hp: target.hp,
                        damage,
                    });
                }

                // Check death — respawn instead of game over
                if (target.hp <= 0) {
                    target.hp = 0;
                    target.alive = false;
                    target.respawnTimer = CFG.RESPAWN_TIME;

                    // Drop ball if carrier
                    if (ball.carrier === target.index) {
                        dropBall(room, target);
                    }

                    for (const p of room.players) {
                        if (p) p.socket.emit("player_killed", {
                            player: target.index,
                            killer: b.owner,
                        });
                    }
                    console.log(`Room ${room.code}: Player ${target.index + 1} killed by Player ${b.owner + 1}`);
                }
            }
        }
    }

    // --- Broadcast game state ---
    const state = {
        players: room.players.map(p => ({
            x: p.x,
            y: p.y,
            hp: p.hp,
            alive: p.alive,
            hasBall: p.hasBall,
            dashCooldown: Math.max(0, CFG.DASH_COOLDOWN - (now - p.lastDashTime)),
            respawnTimer: p.respawnTimer,
        })),
        bullets: room.bullets.map(b => ({
            id: b.id,
            x: b.x,
            y: b.y,
            owner: b.owner,
        })),
        ball: {
            x: ball.x,
            y: ball.y,
            vx: ball.vx,
            vy: ball.vy,
            carrier: ball.carrier,
        },
        score: room.score,
        matchTimer: room.matchTimer,
        overtime: room.overtime,
    };

    for (const p of room.players) {
        if (p) p.socket.emit("game_state", state);
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
            nextBulletId: 0,
            state: "waiting",
            tickInterval: null,
            lastTick: Date.now(),
            ball: { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1 },
            score: [0, 0],
            matchTimer: CFG.MATCH_DURATION,
            overtime: false,
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
        const speed = CFG.PLAYER_SPEED;
        p.vx = (data.dx || 0) * speed;
        p.vy = (data.dy || 0) * speed;
        p.inputSeq = data.seq || 0;
    });

    socket.on("player_shoot", (data) => {
        const room = socket._room;
        if (!room || room.state !== "playing") return;
        const p = room.players[socket._playerIndex];
        if (!p || !p.alive) return;

        const ball = room.ball;

        // If carrying ball → kick it instead of shooting
        if (ball.carrier === p.index) {
            const angle = data.angle || 0;
            ball.vx = Math.cos(angle) * CFG.BALL_KICK_SPEED;
            ball.vy = Math.sin(angle) * CFG.BALL_KICK_SPEED;
            ball.carrier = -1;
            ball.lastKicker = p.index;
            p.hasBall = false;
            for (const pl of room.players) {
                if (pl) pl.socket.emit("ball_kicked", { player: p.index, angle });
            }
            return;
        }

        // Normal shoot
        const now = Date.now();
        const cooldown = CFG.FIRE_COOLDOWN;
        if (now - p.lastFireTime < cooldown) return;
        p.lastFireTime = now;

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

        const ball = room.ball;

        // If carrying ball → super kick toward enemy goal
        if (ball.carrier === p.index) {
            const goal = getGoalY();
            // Enemy goal: P0 kicks right (toward x=ARENA_W), P1 kicks left (toward x=0)
            const targetX = p.index === 0 ? CFG.ARENA_W : 0;
            const targetY = goal.center;
            const angle = Math.atan2(targetY - p.y, targetX - p.x);
            ball.vx = Math.cos(angle) * CFG.BALL_SUPER_KICK_SPEED;
            ball.vy = Math.sin(angle) * CFG.BALL_SUPER_KICK_SPEED;
            ball.carrier = -1;
            ball.lastKicker = p.index;
            p.hasBall = false;
            for (const pl of room.players) {
                if (pl) pl.socket.emit("ball_super_kicked", { player: p.index, angle });
            }
            return;
        }

        // Normal dash
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
            if (pl) pl.socket.emit("player_dash", { player: p.index, x: p.x, y: p.y });
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
            room.lastTick = Date.now();
            room.score = [0, 0];
            room.matchTimer = CFG.MATCH_DURATION;
            room.overtime = false;

            resetPositions(room);

            for (let i = 0; i < 2; i++) {
                const pl = room.players[i];
                pl.lastFireTime = 0;
                pl.lastDashTime = -CFG.DASH_COOLDOWN;
                pl._wantsRestart = false;
                pl.socket.emit("game_start", { index: i, code: room.code, config: CFG });
            }

            room.tickInterval = setInterval(() => tickRoom(room), 1000 / CFG.TICK_RATE);
            console.log(`Room ${room.code}: restarted`);
        } else {
            // Notify waiting
            const other = room.players[1 - socket._playerIndex];
            if (other) other.socket.emit("opponent_wants_restart");
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
    console.log(`K vs K Brawl Ball server running on http://localhost:${PORT}`);
});
