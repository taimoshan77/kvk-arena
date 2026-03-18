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
    GOALS_TO_WIN: 10,
    MATCH_DURATION: 120000,    // 2 minutes
    OVERTIME_DURATION: 60000,  // 1 minute
    RESPAWN_TIME: 3000,        // 3 seconds
    TACKLE_RADIUS: 50,         // dash tackle range
    KICK_PICKUP_GRACE: 2000,   // ms before kicker/tackled player can re-pick up ball

    // Obstacles
    OBSTACLE_COUNT: 4,
    OBSTACLE_MIN_RADIUS: 15,
    OBSTACLE_MAX_RADIUS: 25,
    OBSTACLE_SPAWN_MARGIN: 80,

    // Goalkeepers
    GK_RADIUS: 18,
    GK_SPEED: 80,              // px/s
    GK_DIRECTION_CHANGE: 1500, // ms

    // Weapons
    WEAPON_SPAWN_INTERVAL: 8000,  // ms
    WEAPON_DURATION: 10000,       // ms
    WEAPON_PICKUP_RADIUS: 15,
    WEAPON_MAX_ON_FIELD: 2,
    WEAPON_SPAWN_MARGIN: 60,
};

// ============================================
// BOT SOCKET STUB
// ============================================
function createBotSocket() {
    return {
        emit() {},
        connected: true,
        _room: null,
        _playerIndex: -1,
        isBot: true,
    };
}

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
        ball: { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1, lastKickTime: 0 },
        score: [0, 0],
        matchTimer: CFG.MATCH_DURATION,
        overtime: false,
        obstacles: generateObstacles(),
        goalkeepers: createGoalkeepers(),
        weapons: [],
        nextWeaponId: 0,
        nextWeaponSpawn: Date.now() + CFG.WEAPON_SPAWN_INTERVAL,
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
        weapon: null,
        weaponExpiry: 0,
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
        p.weapon = null;
        p.weaponExpiry = 0;
    }
    room.ball = { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1, lastKickTime: 0 };
    room.bullets = [];
    room.obstacles = generateObstacles();
    room.goalkeepers = createGoalkeepers();
    room.weapons = [];
    room.nextWeaponSpawn = Date.now() + CFG.WEAPON_SPAWN_INTERVAL;
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

// ============================================
// OBSTACLE GENERATION
// ============================================
function generateObstacles() {
    const obstacles = [];
    const margin = CFG.OBSTACLE_SPAWN_MARGIN;
    const centerX = CFG.ARENA_W / 2;
    const centerY = CFG.ARENA_H / 2;
    for (let i = 0; i < CFG.OBSTACLE_COUNT; i++) {
        const r = CFG.OBSTACLE_MIN_RADIUS + Math.random() * (CFG.OBSTACLE_MAX_RADIUS - CFG.OBSTACLE_MIN_RADIUS);
        let x, y, valid;
        let attempts = 0;
        do {
            valid = true;
            x = margin + Math.random() * (CFG.ARENA_W - margin * 2);
            y = margin + Math.random() * (CFG.ARENA_H - margin * 2);
            // Avoid center (ball spawn)
            if (Math.abs(x - centerX) < 80 && Math.abs(y - centerY) < 80) valid = false;
            // Avoid goals
            if (x < 60 || x > CFG.ARENA_W - 60) valid = false;
            // Avoid other obstacles
            for (const o of obstacles) {
                const dx = x - o.x, dy = y - o.y;
                if (Math.sqrt(dx * dx + dy * dy) < r + o.r + 20) valid = false;
            }
            attempts++;
        } while (!valid && attempts < 50);
        if (valid) obstacles.push({ x, y, r });
    }
    return obstacles;
}

// ============================================
// GOALKEEPER HELPERS
// ============================================
function createGoalkeepers() {
    const goalTop = (CFG.ARENA_H - CFG.GOAL_WIDTH) / 2;
    const goalBottom = goalTop + CFG.GOAL_WIDTH;
    const patrolMin = goalTop + CFG.GK_RADIUS;
    const patrolMax = goalBottom - CFG.GK_RADIUS;
    return [
        { x: 15, y: CFG.ARENA_H / 2, dir: 1, nextChange: Date.now() + CFG.GK_DIRECTION_CHANGE, patrolMin, patrolMax, team: 0 },
        { x: CFG.ARENA_W - 15, y: CFG.ARENA_H / 2, dir: -1, nextChange: Date.now() + CFG.GK_DIRECTION_CHANGE, patrolMin, patrolMax, team: 1 },
    ];
}

// ============================================
// WEAPON HELPERS
// ============================================
const WEAPON_TYPES = ["fast", "laser", "bomb"];

function spawnWeapon(room) {
    const margin = CFG.WEAPON_SPAWN_MARGIN;
    const x = margin + Math.random() * (CFG.ARENA_W - margin * 2);
    const y = margin + Math.random() * (CFG.ARENA_H - margin * 2);
    const type = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
    const weapon = { x, y, type, id: room.nextWeaponId++ };
    room.weapons.push(weapon);
    for (const p of room.players) {
        if (p) p.socket.emit("weapon_spawned", { x, y, type, id: weapon.id });
    }
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
// BOT AI
// ============================================
function tickBotAI(room) {
    const bot = room.players[1];
    const opponent = room.players[0];
    if (!bot || !bot.alive || !opponent) return;

    const ball = room.ball;
    const now = Date.now();

    // Target position for movement
    let targetX, targetY;

    if (bot.hasBall) {
        // Move toward enemy goal (left side, x=0) with some y variation toward goal center
        const goalCenter = CFG.ARENA_H / 2;
        targetX = 80;
        targetY = goalCenter + (Math.sin(now / 800) * 40); // weave slightly

        // Kick toward goal when close enough or well-aligned
        const distToGoal = bot.x - 0;
        if (distToGoal < 250) {
            // Kick toward goal center
            const goalY = goalCenter + (Math.random() - 0.5) * CFG.GOAL_WIDTH * 0.6;
            const angle = Math.atan2(goalY - bot.y, 0 - bot.x);
            ball.vx = Math.cos(angle) * CFG.BALL_KICK_SPEED;
            ball.vy = Math.sin(angle) * CFG.BALL_KICK_SPEED;
            ball.carrier = -1;
            ball.lastKicker = bot.index;
            ball.lastKickTime = now;
            bot.hasBall = false;
            for (const pl of room.players) {
                if (pl) pl.socket.emit("ball_kicked", { player: bot.index, angle });
            }
            return;
        }

        // Super kick if very aligned with goal
        if (distToGoal < 400 && Math.abs(bot.y - goalCenter) < CFG.GOAL_WIDTH * 0.4) {
            if (Math.random() < 0.02) { // occasional super kick
                const angle = Math.atan2(goalCenter - bot.y, 0 - bot.x);
                ball.vx = Math.cos(angle) * CFG.BALL_SUPER_KICK_SPEED;
                ball.vy = Math.sin(angle) * CFG.BALL_SUPER_KICK_SPEED;
                ball.carrier = -1;
                ball.lastKicker = bot.index;
                ball.lastKickTime = now;
                bot.hasBall = false;
                for (const pl of room.players) {
                    if (pl) pl.socket.emit("ball_super_kicked", { player: bot.index, angle });
                }
                return;
            }
        }
    } else if (ball.carrier === -1) {
        // Ball is free — go pick it up
        targetX = ball.x;
        targetY = ball.y;
    } else {
        // Opponent has ball — pressure them
        targetX = opponent.x;
        targetY = opponent.y;

        // Dash tackle if close and off cooldown
        const dx = opponent.x - bot.x;
        const dy = opponent.y - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CFG.DASH_DISTANCE + CFG.TACKLE_RADIUS && dist > 0 && now - bot.lastDashTime >= CFG.DASH_COOLDOWN) {
            bot.lastDashTime = now;
            const nx = dx / dist;
            const ny = dy / dist;
            // Set velocity toward opponent for the dash
            bot.vx = nx * CFG.PLAYER_SPEED;
            bot.vy = ny * CFG.PLAYER_SPEED;
            const startX = bot.x;
            const startY = bot.y;
            bot.x += nx * CFG.DASH_DISTANCE;
            bot.y += ny * CFG.DASH_DISTANCE;
            bot.x = clamp(bot.x, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
            bot.y = clamp(bot.y, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);

            for (const pl of room.players) {
                if (pl) pl.socket.emit("player_dash", { player: bot.index, x: bot.x, y: bot.y });
            }

            // Check tackle
            if (ball.carrier === opponent.index) {
                const segDx = bot.x - startX;
                const segDy = bot.y - startY;
                const segLen2 = segDx * segDx + segDy * segDy;
                if (segLen2 > 0) {
                    const t = clamp(((opponent.x - startX) * segDx + (opponent.y - startY) * segDy) / segLen2, 0, 1);
                    const closestX = startX + t * segDx;
                    const closestY = startY + t * segDy;
                    const distX = opponent.x - closestX;
                    const distY = opponent.y - closestY;
                    const dist2 = distX * distX + distY * distY;
                    if (dist2 < CFG.TACKLE_RADIUS * CFG.TACKLE_RADIUS) {
                        const knockAngle = Math.atan2(ny, nx);
                        const knockSpeed = CFG.BALL_KICK_SPEED * 0.6;
                        ball.vx = Math.cos(knockAngle) * knockSpeed;
                        ball.vy = Math.sin(knockAngle) * knockSpeed;
                        ball.carrier = -1;
                        ball.lastKicker = opponent.index;
                        ball.lastKickTime = now;
                        ball.x = opponent.x + Math.cos(knockAngle) * 40;
                        ball.y = opponent.y + Math.sin(knockAngle) * 40;
                        ball.x = clamp(ball.x, CFG.BALL_RADIUS, CFG.ARENA_W - CFG.BALL_RADIUS);
                        ball.y = clamp(ball.y, CFG.BALL_RADIUS, CFG.ARENA_H - CFG.BALL_RADIUS);
                        opponent.hasBall = false;
                        for (const pl of room.players) {
                            if (pl) pl.socket.emit("ball_tackled", { tackler: bot.index, from: opponent.index });
                        }
                    }
                }
            }
            return;
        }
    }

    // Move toward target
    if (targetX !== undefined) {
        const dx = targetX - bot.x;
        const dy = targetY - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 5) {
            bot.vx = (dx / dist) * CFG.PLAYER_SPEED;
            bot.vy = (dy / dist) * CFG.PLAYER_SPEED;
        } else {
            bot.vx = 0;
            bot.vy = 0;
        }
    }

    // Shoot at opponent periodically (when not carrying ball)
    if (!bot.hasBall && opponent.alive && now - bot.lastFireTime >= CFG.FIRE_COOLDOWN) {
        const dx = opponent.x - bot.x;
        const dy = opponent.y - bot.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 350) {
            bot.lastFireTime = now;
            const angle = Math.atan2(dy, dx);
            let bulletSpeed = CFG.BULLET_SPEED;
            let bulletDamage = CFG.BULLET_DAMAGE;
            let piercing = false;
            let bomb = false;
            if (bot.weapon === "fast") bulletSpeed = CFG.BULLET_SPEED * 2;
            else if (bot.weapon === "laser") { piercing = true; bulletDamage = 30; }
            else if (bot.weapon === "bomb") { bomb = true; bulletDamage = 0; }
            room.bullets.push({
                id: room.nextBulletId++,
                x: bot.x, y: bot.y,
                vx: Math.cos(angle) * bulletSpeed,
                vy: Math.sin(angle) * bulletSpeed,
                owner: bot.index,
                damage: bulletDamage,
                piercing, bomb,
                weaponType: bot.weapon || null,
            });
        }
    }
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

    // --- Bot AI ---
    if (room.isBot) {
        tickBotAI(room);
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

    // --- Weapon expiry ---
    for (const p of room.players) {
        if (p.weapon && now >= p.weaponExpiry) {
            p.weapon = null;
            p.weaponExpiry = 0;
            p.socket.emit("weapon_expired_player");
        }
    }

    // --- Weapon spawn timer ---
    if (now >= room.nextWeaponSpawn && room.weapons.length < CFG.WEAPON_MAX_ON_FIELD) {
        spawnWeapon(room);
        room.nextWeaponSpawn = now + CFG.WEAPON_SPAWN_INTERVAL;
    }

    // --- Goalkeeper AI ---
    for (const gk of room.goalkeepers) {
        if (now >= gk.nextChange) {
            gk.dir = -gk.dir;
            gk.nextChange = now + CFG.GK_DIRECTION_CHANGE + Math.random() * 500;
        }
        gk.y += gk.dir * CFG.GK_SPEED * dt;
        if (gk.y < gk.patrolMin) { gk.y = gk.patrolMin; gk.dir = 1; }
        if (gk.y > gk.patrolMax) { gk.y = gk.patrolMax; gk.dir = -1; }
    }

    // --- Update players ---
    const goal = getGoalY();
    for (const p of room.players) {
        if (!p.alive) continue;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.x = clamp(p.x, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
        p.y = clamp(p.y, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);

        // Player-obstacle collision (push out)
        for (const obs of room.obstacles) {
            const dx = p.x - obs.x;
            const dy = p.y - obs.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = CFG.PLAYER_RADIUS + obs.r;
            if (dist < minDist && dist > 0) {
                const nx = dx / dist;
                const ny = dy / dist;
                p.x = obs.x + nx * minDist;
                p.y = obs.y + ny * minDist;
            }
        }

        // Weapon pickup
        for (let wi = room.weapons.length - 1; wi >= 0; wi--) {
            const w = room.weapons[wi];
            const dx = p.x - w.x;
            const dy = p.y - w.y;
            if (dx * dx + dy * dy < (CFG.PLAYER_RADIUS + CFG.WEAPON_PICKUP_RADIUS) * (CFG.PLAYER_RADIUS + CFG.WEAPON_PICKUP_RADIUS)) {
                p.weapon = w.type;
                p.weaponExpiry = now + CFG.WEAPON_DURATION;
                room.weapons.splice(wi, 1);
                for (const pl of room.players) {
                    if (pl) pl.socket.emit("weapon_pickup", { player: p.index, type: w.type, id: w.id });
                }
                break;
            }
        }
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
            // Solid wall
            if (ball.x - CFG.BALL_RADIUS < 0) {
                ball.x = CFG.BALL_RADIUS;
                ball.vx = Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
            if (ball.x + CFG.BALL_RADIUS > CFG.ARENA_W) {
                ball.x = CFG.ARENA_W - CFG.BALL_RADIUS;
                ball.vx = -Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
        } else {
            // In goal opening — bounce off back wall of goal
            if (ball.x - CFG.BALL_RADIUS < -CFG.GOAL_DEPTH) {
                ball.x = -CFG.GOAL_DEPTH + CFG.BALL_RADIUS;
                ball.vx = Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
            if (ball.x + CFG.BALL_RADIUS > CFG.ARENA_W + CFG.GOAL_DEPTH) {
                ball.x = CFG.ARENA_W + CFG.GOAL_DEPTH - CFG.BALL_RADIUS;
                ball.vx = -Math.abs(ball.vx) * CFG.BALL_BOUNCE_DAMPING;
            }
        }

        // Goal post collision — bounce off top/bottom edges of goal opening
        // Ball approaching goal opening from inside arena and hitting the post
        if (ball.x - CFG.BALL_RADIUS < 0 || ball.x + CFG.BALL_RADIUS > CFG.ARENA_W) {
            // Ball is at or past the wall line — check if it hit a goal post
            if (ball.y - CFG.BALL_RADIUS < goal.top && ball.y + CFG.BALL_RADIUS > goal.top - 10) {
                // Hit top goal post — bounce down
                ball.y = goal.top + CFG.BALL_RADIUS;
                ball.vy = Math.abs(ball.vy) * CFG.BALL_BOUNCE_DAMPING;
                ball.vx *= CFG.BALL_BOUNCE_DAMPING;
            }
            if (ball.y + CFG.BALL_RADIUS > goal.bottom && ball.y - CFG.BALL_RADIUS < goal.bottom + 10) {
                // Hit bottom goal post — bounce up
                ball.y = goal.bottom - CFG.BALL_RADIUS;
                ball.vy = -Math.abs(ball.vy) * CFG.BALL_BOUNCE_DAMPING;
                ball.vx *= CFG.BALL_BOUNCE_DAMPING;
            }
        }

        // --- Ball-obstacle collision ---
        for (const obs of room.obstacles) {
            const dx = ball.x - obs.x;
            const dy = ball.y - obs.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = CFG.BALL_RADIUS + obs.r;
            if (dist < minDist && dist > 0) {
                // Push ball out
                const nx = dx / dist;
                const ny = dy / dist;
                ball.x = obs.x + nx * minDist;
                ball.y = obs.y + ny * minDist;
                // Reflect velocity
                const dot = ball.vx * nx + ball.vy * ny;
                ball.vx -= 2 * dot * nx;
                ball.vy -= 2 * dot * ny;
                ball.vx *= CFG.BALL_BOUNCE_DAMPING;
                ball.vy *= CFG.BALL_BOUNCE_DAMPING;
            }
        }

        // --- Ball-GK collision ---
        for (const gk of room.goalkeepers) {
            const dx = ball.x - gk.x;
            const dy = ball.y - gk.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = CFG.BALL_RADIUS + CFG.GK_RADIUS;
            if (dist < minDist && dist > 0) {
                const nx = dx / dist;
                const ny = dy / dist;
                ball.x = gk.x + nx * minDist;
                ball.y = gk.y + ny * minDist;
                // Reflect with extra outward push
                const dot = ball.vx * nx + ball.vy * ny;
                ball.vx -= 2 * dot * nx;
                ball.vy -= 2 * dot * ny;
                // Extra push away from goal
                const pushDir = gk.team === 0 ? 1 : -1;
                ball.vx += pushDir * 80;
                ball.vx *= CFG.BALL_BOUNCE_DAMPING;
                ball.vy *= CFG.BALL_BOUNCE_DAMPING;
            }
        }

        // --- Goal detection ---
        // Score when ball center crosses the wall line into the goal opening
        // Left goal (P0 defends): P1 scores
        if (ball.x <= 0 && inGoalOpening) {
            scoreGoal(room, 1);
            return;
        }
        // Right goal (P1 defends): P0 scores
        if (ball.x >= CFG.ARENA_W && inGoalOpening) {
            scoreGoal(room, 0);
            return;
        }

        // --- Ball pickup ---
        for (const p of room.players) {
            if (!p.alive) continue;
            // Grace period: kicker can't immediately re-pick up
            if (p.index === ball.lastKicker && (now - ball.lastKickTime) < CFG.KICK_PICKUP_GRACE) continue;
            const dx = ball.x - p.x;
            const dy = ball.y - p.y;
            if (dx * dx + dy * dy < CFG.BALL_PICKUP_RADIUS * CFG.BALL_PICKUP_RADIUS) {
                ball.carrier = p.index;
                ball.lastKicker = -1; // reset so future pickups work
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

        // Bullet-obstacle collision (destroy bullet, unless laser)
        if (!b.piercing) {
            let hitObs = false;
            for (const obs of room.obstacles) {
                const dx = b.x - obs.x;
                const dy = b.y - obs.y;
                if (dx * dx + dy * dy < (CFG.BULLET_RADIUS + obs.r) * (CFG.BULLET_RADIUS + obs.r)) {
                    hitObs = true;
                    break;
                }
            }
            if (hitObs) {
                room.bullets.splice(i, 1);
                continue;
            }
        }

        // Hit detection against opponent
        const target = room.players[1 - b.owner];
        if (target && target.alive) {
            const dx = b.x - target.x;
            const dy = b.y - target.y;
            if (dx * dx + dy * dy < (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS) * (CFG.BULLET_RADIUS + CFG.PLAYER_RADIUS)) {
                // Bomb: AoE damage to all players in radius
                if (b.bomb) {
                    const aoeDamage = 40;
                    const aoeRadius = 80;
                    for (const p of room.players) {
                        if (!p || !p.alive) continue;
                        const adx = b.x - p.x;
                        const ady = b.y - p.y;
                        if (adx * adx + ady * ady < aoeRadius * aoeRadius) {
                            p.hp -= aoeDamage;
                            for (const pl of room.players) {
                                if (pl) pl.socket.emit("player_hit", { target: p.index, hp: p.hp, damage: aoeDamage });
                            }
                            if (p.hp <= 0) {
                                p.hp = 0;
                                p.alive = false;
                                p.respawnTimer = CFG.RESPAWN_TIME;
                                if (ball.carrier === p.index) dropBall(room, p);
                                for (const pl of room.players) {
                                    if (pl) pl.socket.emit("player_killed", { player: p.index, killer: b.owner });
                                }
                            }
                        }
                    }
                    for (const pl of room.players) {
                        if (pl) pl.socket.emit("bomb_explode", { x: b.x, y: b.y, radius: aoeRadius });
                    }
                    room.bullets.splice(i, 1);
                    continue;
                }

                const damage = b.damage || CFG.BULLET_DAMAGE;
                target.hp -= damage;
                // Laser pierces (don't remove bullet), normal bullets removed
                if (!b.piercing) {
                    room.bullets.splice(i, 1);
                }

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
            weapon: p.weapon,
            weaponTimer: p.weapon ? Math.max(0, p.weaponExpiry - now) : 0,
        })),
        bullets: room.bullets.map(b => ({
            id: b.id,
            x: b.x,
            y: b.y,
            vx: b.vx,
            vy: b.vy,
            owner: b.owner,
            weaponType: b.weaponType || null,
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
        obstacles: room.obstacles,
        goalkeepers: room.goalkeepers.map(gk => ({ x: gk.x, y: gk.y, team: gk.team })),
        weapons: room.weapons.map(w => ({ x: w.x, y: w.y, type: w.type, id: w.id })),
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
            ball: { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1, lastKicker: -1, lastKickTime: 0 },
            score: [0, 0],
            matchTimer: CFG.MATCH_DURATION,
            overtime: false,
            obstacles: generateObstacles(),
            goalkeepers: createGoalkeepers(),
            weapons: [],
            nextWeaponId: 0,
            nextWeaponSpawn: Date.now() + CFG.WEAPON_SPAWN_INTERVAL,
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

    socket.on("start_solo", () => {
        const botSocket = createBotSocket();
        const room = createRoom(socket, botSocket);
        room.isBot = true;
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
            ball.lastKickTime = Date.now();
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
        let bulletSpeed = CFG.BULLET_SPEED;
        let bulletDamage = CFG.BULLET_DAMAGE;
        let piercing = false;
        let bomb = false;

        if (p.weapon === "fast") {
            bulletSpeed = CFG.BULLET_SPEED * 2;
        } else if (p.weapon === "laser") {
            piercing = true;
            bulletDamage = 30;
        } else if (p.weapon === "bomb") {
            bomb = true;
            bulletDamage = 0; // damage handled by AoE
        }

        const vx = Math.cos(angle) * bulletSpeed;
        const vy = Math.sin(angle) * bulletSpeed;

        const bullet = {
            id: room.nextBulletId++,
            x: p.x,
            y: p.y,
            vx,
            vy,
            owner: p.index,
            damage: bulletDamage,
            piercing,
            bomb,
            weaponType: p.weapon || null,
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
            ball.lastKickTime = Date.now();
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

        // Dash tackle — check along entire dash path for collision with carrier
        const opponent = room.players[1 - p.index];
        if (opponent && opponent.alive && ball.carrier === opponent.index && mag > 0) {
            // Check if dash line segment passes within tackle range of opponent
            // Line segment from (startX, startY) to (p.x, p.y)
            const startX = p.x - (p.vx / mag) * CFG.DASH_DISTANCE;
            const startY = p.y - (p.vy / mag) * CFG.DASH_DISTANCE;
            const segDx = p.x - startX;
            const segDy = p.y - startY;
            const segLen2 = segDx * segDx + segDy * segDy;
            // Project opponent onto line segment
            const t = clamp(((opponent.x - startX) * segDx + (opponent.y - startY) * segDy) / segLen2, 0, 1);
            const closestX = startX + t * segDx;
            const closestY = startY + t * segDy;
            const distX = opponent.x - closestX;
            const distY = opponent.y - closestY;
            const dist2 = distX * distX + distY * distY;
            if (dist2 < CFG.TACKLE_RADIUS * CFG.TACKLE_RADIUS) {
                // Knock ball away in tackle direction, offset from opponent
                const knockAngle = Math.atan2(p.vy, p.vx);
                const knockSpeed = CFG.BALL_KICK_SPEED * 0.6;
                ball.vx = Math.cos(knockAngle) * knockSpeed;
                ball.vy = Math.sin(knockAngle) * knockSpeed;
                ball.carrier = -1;
                // Grace period prevents tackled player from re-grabbing
                ball.lastKicker = opponent.index;
                ball.lastKickTime = Date.now();
                // Offset ball ahead so it's not on top of the opponent
                ball.x = opponent.x + Math.cos(knockAngle) * 40;
                ball.y = opponent.y + Math.sin(knockAngle) * 40;
                ball.x = clamp(ball.x, CFG.BALL_RADIUS, CFG.ARENA_W - CFG.BALL_RADIUS);
                ball.y = clamp(ball.y, CFG.BALL_RADIUS, CFG.ARENA_H - CFG.BALL_RADIUS);
                opponent.hasBall = false;
                for (const pl of room.players) {
                    if (pl) pl.socket.emit("ball_tackled", { tackler: p.index, from: opponent.index });
                }
                console.log(`Room ${room.code}: Player ${p.index + 1} tackled Player ${opponent.index + 1}`);
            }
        }
    });

    socket.on("restart_request", () => {
        const room = socket._room;
        if (!room || room.state !== "done") return;
        const p = room.players[socket._playerIndex];
        p._wantsRestart = true;

        // In bot mode, auto-accept for bot
        if (room.isBot) {
            room.players[1]._wantsRestart = true;
        }

        // Check if both want restart
        if (room.players[0]._wantsRestart && room.players[1]._wantsRestart) {
            // Reset game
            room.state = "playing";
            room.bullets = [];
            room.lastTick = Date.now();
            room.score = [0, 0];
            room.matchTimer = CFG.MATCH_DURATION;
            room.overtime = false;
            room.nextWeaponId = 0;

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
