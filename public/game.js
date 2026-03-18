// ============================================
// K vs K — Brawl Ball Client
// ============================================

(() => {
"use strict";

// ============================================
// CONFIG (overridden by server on game_start)
// ============================================
let CFG = {
    ARENA_W: 800,
    ARENA_H: 600,
    PLAYER_SPEED: 200,
    PLAYER_HP: 100,
    PLAYER_RADIUS: 20,
    BULLET_SPEED: 400,
    BULLET_RADIUS: 5,
    BULLET_DAMAGE: 10,
    FIRE_COOLDOWN: 333,
    DASH_DISTANCE: 150,
    DASH_COOLDOWN: 5000,
    TICK_RATE: 20,
    BALL_RADIUS: 12,
    BALL_PICKUP_RADIUS: 30,
    BALL_KICK_SPEED: 500,
    BALL_SUPER_KICK_SPEED: 700,
    GOAL_WIDTH: 120,
    GOAL_DEPTH: 30,
    GOALS_TO_WIN: 10,
    MATCH_DURATION: 120000,
    OVERTIME_DURATION: 60000,
    RESPAWN_TIME: 3000,
};

// ============================================
// SFX — Procedural Sound Effects
// ============================================
const SFX = {
    ctx: null,
    _ensureCtx() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === "suspended") this.ctx.resume();
        return this.ctx;
    },
    _osc(type, freq, endFreq, dur, vol) {
        const c = this._ensureCtx();
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, c.currentTime);
        if (endFreq !== freq) o.frequency.linearRampToValueAtTime(endFreq, c.currentTime + dur);
        g.gain.setValueAtTime(vol || 0.12, c.currentTime);
        g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
        o.connect(g).connect(c.destination);
        o.start(); o.stop(c.currentTime + dur);
    },
    _noise(dur, vol, filterFreq) {
        const c = this._ensureCtx();
        const len = c.sampleRate * dur;
        const buf = c.createBuffer(1, len, c.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
        const src = c.createBufferSource();
        src.buffer = buf;
        const g = c.createGain();
        g.gain.setValueAtTime(vol || 0.1, c.currentTime);
        g.gain.linearRampToValueAtTime(0, c.currentTime + dur);
        if (filterFreq) {
            const f = c.createBiquadFilter();
            f.type = "lowpass"; f.frequency.value = filterFreq;
            src.connect(f).connect(g).connect(c.destination);
        } else {
            src.connect(g).connect(c.destination);
        }
        src.start(); src.stop(c.currentTime + dur);
    },
    shoot() { this._osc("square", 660, 220, 0.08, 0.07); },
    hit() { this._osc("sawtooth", 200, 60, 0.12, 0.1); this._noise(0.08, 0.08, 1000); },
    dash() { this._osc("sine", 220, 880, 0.12, 0.08); },
    kick() { this._osc("triangle", 120, 60, 0.15, 0.15); this._noise(0.06, 0.06, 600); },
    goal() {
        const c = this._ensureCtx();
        [523, 659, 784, 1047].forEach((freq, i) => {
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = "sine"; o.frequency.value = freq;
            const t = c.currentTime + i * 0.08;
            g.gain.setValueAtTime(0.12, t);
            g.gain.linearRampToValueAtTime(0, t + 0.15);
            o.connect(g).connect(c.destination);
            o.start(t); o.stop(t + 0.15);
        });
    },
    respawn() {
        const c = this._ensureCtx();
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = "sine";
        o.frequency.setValueAtTime(200, c.currentTime);
        o.frequency.linearRampToValueAtTime(800, c.currentTime + 0.2);
        g.gain.setValueAtTime(0.08, c.currentTime);
        g.gain.linearRampToValueAtTime(0, c.currentTime + 0.25);
        o.connect(g).connect(c.destination);
        o.start(); o.stop(c.currentTime + 0.25);
    },
    win() {
        const c = this._ensureCtx();
        [523, 659, 784, 1047, 1319].forEach((freq, i) => {
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = "sine"; o.frequency.value = freq;
            const t = c.currentTime + i * 0.1;
            g.gain.setValueAtTime(0.1, t);
            g.gain.linearRampToValueAtTime(0, t + 0.2);
            o.connect(g).connect(c.destination);
            o.start(t); o.stop(t + 0.2);
        });
    },
    lose() {
        const c = this._ensureCtx();
        [440, 415, 370, 330, 262].forEach((freq, i) => {
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = "sine"; o.frequency.value = freq;
            const t = c.currentTime + i * 0.15;
            g.gain.setValueAtTime(0.1, t);
            g.gain.linearRampToValueAtTime(0, t + 0.2);
            o.connect(g).connect(c.destination);
            o.start(t); o.stop(t + 0.2);
        });
    },
    click() { this._osc("sine", 660, 660, 0.03, 0.06); },
};

// ============================================
// MUSIC — Audio file BGM
// ============================================
const Music = {
    audio: null,
    playing: false,

    start() {
        if (this.playing) return;
        SFX._ensureCtx();
        if (!this.audio) {
            this.audio = new Audio();
            const canOgg = this.audio.canPlayType("audio/ogg; codecs=vorbis");
            this.audio.src = canOgg ? "/assets/bgm.ogg" : "/assets/bgm.mp3";
            this.audio.loop = true;
            this.audio.volume = 0.25;
        }
        this.audio.currentTime = 0;
        this.audio.play().catch(() => {});
        this.playing = true;
    },

    stop() {
        if (this.audio) {
            this.audio.pause();
            this.audio.currentTime = 0;
        }
        this.playing = false;
    },
};

// ============================================
// GLOBALS
// ============================================
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

let W, H;             // Viewport
let scaleX, scaleY;    // Arena → screen scale
let offsetX, offsetY;  // Arena offset on screen
let isMobile = false;
let gameState = "title"; // title, waiting, playing, gameover
let myIndex = -1;
let inputSeq = 0;

// Socket
let socket = null;

// Game entities (from server)
let players = [
    { x: 150, y: 300, hp: 100, alive: true, hasBall: false, dashCooldown: 0, respawnTimer: 0 },
    { x: 650, y: 300, hp: 100, alive: true, hasBall: false, dashCooldown: 0, respawnTimer: 0 },
];
let bullets = [];

// Brawl Ball state
let ball = { x: 400, y: 300, vx: 0, vy: 0, carrier: -1 };
let score = [0, 0];
let matchTimer = 120000;
let overtime = false;
let goalFlash = 0; // screen flash on goal

// New entities
let obstacles = [];
let goalkeepers = [];
let weapons = [];
let bombExplosions = []; // visual only

// Local input
const keys = {};
const mobileInput = { dx: 0, dy: 0, fire: false, dash: false };

// Local movement prediction
let localX = 150, localY = 300;
let localVx = 0, localVy = 0;

// Interpolation
let prevState = null;
let currState = null;
let stateTime = 0;
const INTERP_DELAY = 50; // ms

// Sprites (directional)
const sprites = {
    k1: null, k2: null,
    k1_front: null, k1_back: null, k1_left: null, k1_right: null,
    k2_front: null, k2_back: null, k2_left: null, k2_right: null,
};
let spritesLoaded = 0;
let playerDir = ["front", "front"];

// Particles
const particlePool = [];
const activeParticles = [];

// Animation state
let hitFlash = [0, 0];
let dashTrail = [];
let moveTime = 0;

// Aiming
let aimAngle = 0;
let mouseX = 0, mouseY = 0;

// Arena decorations
let arenaDecorations = [];

// Confetti
let confettiPieces = [];
let confettiCanvas = null;
let confettiCtx = null;
let confettiAnimId = null;

// ============================================
// UTILITY
// ============================================
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }

function arenaToScreen(ax, ay) {
    return { x: offsetX + ax * scaleX, y: offsetY + ay * scaleY };
}

function screenToArena(sx, sy) {
    return { x: (sx - offsetX) / scaleX, y: (sy - offsetY) / scaleY };
}

function resize() {
    const dpr = window.devicePixelRatio || 1;
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const arenaAspect = CFG.ARENA_W / CFG.ARENA_H;
    const screenAspect = W / H;
    if (screenAspect > arenaAspect) {
        scaleY = H / CFG.ARENA_H;
        scaleX = scaleY;
        offsetX = (W - CFG.ARENA_W * scaleX) / 2;
        offsetY = 0;
    } else {
        scaleX = W / CFG.ARENA_W;
        scaleY = scaleX;
        offsetX = 0;
        offsetY = (H - CFG.ARENA_H * scaleY) / 2;
    }
}

function detectMobile() {
    isMobile = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0) || window.innerWidth <= 768;
}

function notify(text, type) {
    const el = document.createElement("div");
    el.className = `notification notif-${type || "hit"}`;
    el.textContent = text;
    document.getElementById("notifications").appendChild(el);
    setTimeout(() => el.remove(), 2000);
}

function showScreen(id) {
    document.querySelectorAll(".overlay").forEach(el => el.classList.add("hidden"));
    const el = document.getElementById(id);
    if (el) el.classList.remove("hidden");
}

function showError(msg) {
    const el = document.getElementById("error-display");
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 3000);
}

function formatTime(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min}:${sec.toString().padStart(2, "0")}`;
}

// ============================================
// SPRITES
// ============================================
function loadSprites() {
    ["k1", "k2"].forEach(name => {
        const img = new Image();
        img.onload = () => { sprites[name] = img; spritesLoaded++; };
        img.src = `/assets/${name}.png`;
    });
    const dirs = ["front", "back", "left", "right"];
    ["k1", "k2"].forEach(name => {
        dirs.forEach(dir => {
            const img = new Image();
            img.onload = () => { sprites[`${name}_${dir}`] = img; };
            img.src = `/assets/${name}-${dir}.png`;
        });
    });
}

// ============================================
// ARENA DECORATIONS
// ============================================
function generateDecorations() {
    arenaDecorations = [];
    for (let i = 0; i < 8; i++) {
        const margin = 60;
        let x, y;
        do {
            x = margin + Math.random() * (CFG.ARENA_W - margin * 2);
            y = margin + Math.random() * (CFG.ARENA_H - margin * 2);
        } while (Math.abs(x - CFG.ARENA_W / 2) < 120 && Math.abs(y - CFG.ARENA_H / 2) < 100);
        arenaDecorations.push({
            type: "bush",
            x, y,
            size: 10 + Math.random() * 14,
            shade: Math.random() * 0.3,
        });
    }
    for (let i = 0; i < 6; i++) {
        arenaDecorations.push({
            type: "crate",
            x: 50 + Math.random() * (CFG.ARENA_W - 100),
            y: 50 + Math.random() * (CFG.ARENA_H - 100),
            size: 8 + Math.random() * 8,
            shade: Math.random() * 0.3,
        });
    }
}

// ============================================
// PARTICLES
// ============================================
function spawnParticle(x, y, vx, vy, life, color, size) {
    const p = particlePool.pop() || {};
    p.x = x; p.y = y; p.vx = vx; p.vy = vy;
    p.life = life; p.maxLife = life;
    p.color = color; p.size = size || 3;
    activeParticles.push(p);
}

function spawnExplosion(x, y, color, count) {
    const colors = [color, "#ffaa00", "#ffdd44", "#fff"];
    for (let i = 0; i < (count || 16); i++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 40 + Math.random() * 120;
        const c = colors[Math.floor(Math.random() * colors.length)];
        spawnParticle(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd,
            0.4 + Math.random() * 0.4, c, 2 + Math.random() * 4);
    }
}

function spawnSparkle(x, y, color) {
    for (let i = 0; i < 4; i++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 20 + Math.random() * 40;
        spawnParticle(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd,
            0.3 + Math.random() * 0.2, color, 1 + Math.random() * 2);
    }
}

function updateParticles(dt) {
    for (let i = activeParticles.length - 1; i >= 0; i--) {
        const p = activeParticles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.94;
        p.vy *= 0.94;
        p.life -= dt;
        if (p.life <= 0) {
            activeParticles.splice(i, 1);
            particlePool.push(p);
        }
    }
}

function drawParticles() {
    for (const p of activeParticles) {
        const alpha = clamp(p.life / p.maxLife, 0, 1);
        const sp = arenaToScreen(p.x, p.y);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, p.size * scaleX * alpha, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ============================================
// CONFETTI SYSTEM
// ============================================
function startConfetti() {
    confettiCanvas = document.getElementById("confetti-canvas");
    if (!confettiCanvas) return;
    confettiCtx = confettiCanvas.getContext("2d");
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
    confettiPieces = [];
    const colors = ["#ff4466", "#44ff88", "#4488ff", "#ffd700", "#ff88ff", "#44ffff"];
    for (let i = 0; i < 80; i++) {
        confettiPieces.push({
            x: Math.random() * confettiCanvas.width,
            y: -20 - Math.random() * 200,
            w: 6 + Math.random() * 8,
            h: 4 + Math.random() * 6,
            vx: (Math.random() - 0.5) * 3,
            vy: 2 + Math.random() * 4,
            rot: Math.random() * Math.PI * 2,
            rotV: (Math.random() - 0.5) * 0.2,
            color: colors[Math.floor(Math.random() * colors.length)],
        });
    }
    confettiAnimId = requestAnimationFrame(animateConfetti);
}

function stopConfetti() {
    if (confettiAnimId) cancelAnimationFrame(confettiAnimId);
    confettiAnimId = null;
    if (confettiCtx && confettiCanvas) confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
}

function animateConfetti() {
    if (!confettiCtx || !confettiCanvas) return;
    confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    let alive = false;
    for (const p of confettiPieces) {
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.rotV;
        p.vy += 0.05;
        if (p.y < confettiCanvas.height + 20) alive = true;
        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rot);
        confettiCtx.fillStyle = p.color;
        confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        confettiCtx.restore();
    }
    if (alive) confettiAnimId = requestAnimationFrame(animateConfetti);
}

// ============================================
// SOCKET.IO
// ============================================
function connectSocket() {
    if (socket && socket.connected) return;
    socket = io();

    socket.on("room_created", (data) => {
        document.getElementById("room-code-val").textContent = data.code;
        showScreen("waiting-screen");
    });

    socket.on("queue_status", (data) => {
        const qs = document.getElementById("queue-status");
        qs.textContent = `Searching for opponent...`;
        qs.classList.remove("hidden");
        showScreen("waiting-screen");
        document.getElementById("room-code-val").textContent = "----";
    });

    socket.on("game_start", (data) => {
        myIndex = data.index;
        if (data.config) CFG = data.config;

        // Reset state
        players = [
            { x: 150, y: 300, hp: CFG.PLAYER_HP, alive: true, hasBall: false, dashCooldown: 0, respawnTimer: 0 },
            { x: 650, y: 300, hp: CFG.PLAYER_HP, alive: true, hasBall: false, dashCooldown: 0, respawnTimer: 0 },
        ];
        bullets = [];
        ball = { x: CFG.ARENA_W / 2, y: CFG.ARENA_H / 2, vx: 0, vy: 0, carrier: -1 };
        score = [0, 0];
        matchTimer = CFG.MATCH_DURATION;
        overtime = false;
        goalFlash = 0;
        hitFlash = [0, 0];
        dashTrail = [];
        activeParticles.length = 0;
        moveTime = 0;
        obstacles = [];
        goalkeepers = [];
        weapons = [];
        bombExplosions = [];
        localX = players[myIndex].x;
        localY = players[myIndex].y;
        localVx = 0;
        localVy = 0;
        prevState = null;
        currState = null;

        generateDecorations();

        gameState = "playing";
        showScreen(null);
        stopConfetti();
        document.getElementById("hud").classList.remove("hidden");
        if (isMobile) document.getElementById("mobile-controls").classList.remove("hidden");

        notify("KICK OFF!", "big");
        resize();

        Music.start();
    });

    socket.on("game_state", (state) => {
        prevState = currState;
        currState = { ...state, time: Date.now() };

        // Update authoritative state
        for (let i = 0; i < 2; i++) {
            const sp = state.players[i];
            players[i].hp = sp.hp;
            players[i].alive = sp.alive;
            players[i].hasBall = sp.hasBall;
            players[i].dashCooldown = sp.dashCooldown;
            players[i].respawnTimer = sp.respawnTimer;
            players[i].weapon = sp.weapon;
            players[i].weaponTimer = sp.weaponTimer;

            if (i !== myIndex) {
                players[i].targetX = sp.x;
                players[i].targetY = sp.y;
                if (players[i].x === undefined || players[i].x === 0) {
                    players[i].x = sp.x;
                    players[i].y = sp.y;
                }
            } else {
                const dx = sp.x - localX;
                const dy = sp.y - localY;
                const drift = Math.hypot(dx, dy);
                if (drift > 30) {
                    localX = sp.x;
                    localY = sp.y;
                } else if (drift > 2) {
                    localX = lerp(localX, sp.x, 0.15);
                    localY = lerp(localY, sp.y, 0.15);
                }
            }
        }

        bullets = state.bullets;

        // Update ball
        ball = state.ball;
        score = state.score;
        matchTimer = state.matchTimer;
        overtime = state.overtime;

        // Update new entities
        if (state.obstacles) obstacles = state.obstacles;
        if (state.goalkeepers) goalkeepers = state.goalkeepers;
        if (state.weapons) weapons = state.weapons;
    });

    socket.on("player_hit", (data) => {
        SFX.hit();
        hitFlash[data.target] = 0.3;
        spawnExplosion(players[data.target].x, players[data.target].y,
            data.target === myIndex ? "#ff0044" : "#ff8844", 16);
        if (data.target === myIndex) {
            notify(`-${data.damage} HP`, "hit");
        }
    });

    socket.on("player_killed", (data) => {
        spawnExplosion(players[data.player].x, players[data.player].y, "#ff0044", 24);
        if (data.player === myIndex) {
            notify("ELIMINATED!", "hit");
        } else {
            notify("ENEMY DOWN!", "dash");
        }
    });

    socket.on("player_respawn", (data) => {
        SFX.respawn();
        players[data.player].x = data.x;
        players[data.player].y = data.y;
        if (data.player === myIndex) {
            localX = data.x;
            localY = data.y;
            localVx = 0;
            localVy = 0;
            notify("RESPAWNED!", "dash");
        }
        // Spawn ring effect
        for (let i = 0; i < 12; i++) {
            const angle = (i / 12) * Math.PI * 2;
            spawnParticle(data.x, data.y, Math.cos(angle) * 60, Math.sin(angle) * 60,
                0.5, "#44ffff", 3);
        }
    });

    socket.on("ball_pickup", (data) => {
        if (data.player === myIndex) {
            SFX.kick();
        }
    });

    socket.on("ball_kicked", (data) => {
        SFX.kick();
        spawnSparkle(players[data.player].x, players[data.player].y, "#ffd700");
    });

    socket.on("ball_super_kicked", (data) => {
        SFX.kick();
        SFX.dash();
        spawnExplosion(players[data.player].x, players[data.player].y, "#ffd700", 12);
        if (data.player === myIndex) {
            notify("SUPER KICK!", "powerup");
        }
    });

    socket.on("ball_tackled", (data) => {
        SFX.hit();
        spawnExplosion(players[data.from].x, players[data.from].y, "#ff8800", 16);
        if (data.tackler === myIndex) {
            notify("TACKLE!", "dash");
        } else {
            notify("TACKLED!", "hit");
        }
    });

    socket.on("weapon_pickup", (data) => {
        if (data.player === myIndex) {
            SFX.dash();
            notify(`${data.type.toUpperCase()} WEAPON!`, "powerup");
        }
        // Remove from local weapons array
        weapons = weapons.filter(w => w.id !== data.id);
    });

    socket.on("weapon_spawned", (data) => {
        weapons.push({ x: data.x, y: data.y, type: data.type, id: data.id });
    });

    socket.on("weapon_expired_player", () => {
        notify("WEAPON EXPIRED", "hit");
    });

    socket.on("bomb_explode", (data) => {
        SFX.hit();
        bombExplosions.push({ x: data.x, y: data.y, radius: data.radius, alpha: 1.0 });
        spawnExplosion(data.x, data.y, "#ff4400", 30);
    });

    socket.on("goal_scored", (data) => {
        SFX.goal();
        score = data.score;
        goalFlash = 1.0;
        notify("GOAL!", "big");
        // Big explosion at ball position
        spawnExplosion(ball.x, ball.y, "#ffd700", 30);
    });

    socket.on("overtime_start", () => {
        overtime = true;
        notify("OVERTIME!", "big");
    });

    socket.on("player_dash", (data) => {
        SFX.dash();
        const rainbowColors = ["#ff4444", "#ff8800", "#ffdd00", "#44ff44", "#4488ff", "#aa44ff"];
        for (let i = 0; i < 8; i++) {
            dashTrail.push({
                x: lerp(players[data.player].x, data.x, i / 8),
                y: lerp(players[data.player].y, data.y, i / 8),
                alpha: 0.7 - i * 0.08,
                index: data.player,
                color: rainbowColors[i % rainbowColors.length],
            });
        }
        players[data.player].x = data.x;
        players[data.player].y = data.y;
        if (data.player === myIndex) {
            localX = data.x;
            localY = data.y;
            notify("DASH!", "dash");
        }
    });

    socket.on("game_over", (data) => {
        gameState = "gameover";
        const isWinner = data.winner === myIndex;
        const isDraw = data.winner === -1;

        Music.stop();

        if (isDraw) {
            SFX.lose();
        } else if (isWinner) {
            SFX.win();
        } else {
            SFX.lose();
        }

        const titleEl = document.getElementById("result-title");
        if (isDraw) {
            titleEl.textContent = "DRAW!";
            titleEl.className = "screen-title result-title";
        } else {
            titleEl.textContent = isWinner ? "YOU WIN!" : "YOU LOSE";
            titleEl.className = "screen-title result-title " + (isWinner ? "win" : "lose");
        }

        const finalScore = data.score || score;
        document.getElementById("result-my-score").textContent = finalScore[myIndex];
        document.getElementById("result-opp-score").textContent = finalScore[1 - myIndex];
        document.getElementById("restart-status").classList.add("hidden");

        document.getElementById("hud").classList.add("hidden");
        document.getElementById("mobile-controls").classList.add("hidden");
        showScreen("gameover-screen");

        if (isWinner) startConfetti();
    });

    socket.on("opponent_disconnected", () => {
        if (gameState === "playing") {
            Music.stop();
            notify("OPPONENT LEFT", "big");
            gameState = "gameover";
            const titleEl = document.getElementById("result-title");
            titleEl.textContent = "YOU WIN!";
            titleEl.className = "screen-title result-title win";
            document.getElementById("result-my-score").textContent = score[myIndex];
            document.getElementById("result-opp-score").textContent = "DC";
            document.getElementById("hud").classList.add("hidden");
            document.getElementById("mobile-controls").classList.add("hidden");
            showScreen("gameover-screen");
            SFX.win();
            startConfetti();
        } else if (gameState === "waiting") {
            showScreen("title-screen");
        }
    });

    socket.on("opponent_wants_restart", () => {
        const rs = document.getElementById("restart-status");
        rs.textContent = "Opponent wants rematch!";
        rs.classList.remove("hidden");
    });

    socket.on("error_msg", (data) => {
        showError(data.message);
    });

    socket.on("disconnect", () => {
        Music.stop();
        if (gameState === "playing" || gameState === "waiting") {
            showError("Disconnected from server");
            showScreen("title-screen");
            gameState = "title";
        }
    });
}

// ============================================
// INPUT — Keyboard
// ============================================
document.addEventListener("keydown", (e) => {
    keys[e.code] = true;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
    }
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (gameState === "playing" && socket) {
            socket.emit("player_ability");
        }
    }
    SFX._ensureCtx();
});

document.addEventListener("keyup", (e) => {
    keys[e.code] = false;
});

// Mouse for aiming/shooting
canvas.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    updateAimAngle();
});

canvas.addEventListener("mousedown", (e) => {
    if (gameState !== "playing") return;
    SFX._ensureCtx();
    mouseX = e.clientX;
    mouseY = e.clientY;
    updateAimAngle();
    if (socket) {
        socket.emit("player_shoot", { angle: aimAngle });
    }
});

// Auto-fire on hold
let mouseDown = false;
let autoFireInterval = null;
canvas.addEventListener("mousedown", () => {
    mouseDown = true;
    if (!autoFireInterval) {
        autoFireInterval = setInterval(() => {
            if (mouseDown && gameState === "playing" && socket) {
                updateAimAngle();
                socket.emit("player_shoot", { angle: aimAngle });
            }
        }, CFG.FIRE_COOLDOWN);
    }
});
canvas.addEventListener("mouseup", () => {
    mouseDown = false;
    if (autoFireInterval) { clearInterval(autoFireInterval); autoFireInterval = null; }
});
canvas.addEventListener("mouseleave", () => {
    mouseDown = false;
    if (autoFireInterval) { clearInterval(autoFireInterval); autoFireInterval = null; }
});

function updateAimAngle() {
    if (gameState !== "playing") return;
    const p = arenaToScreen(localX, localY);
    aimAngle = Math.atan2(mouseY - p.y, mouseX - p.x);
}

// ============================================
// INPUT — Mobile Joystick
// ============================================
let joystickTouch = null;
const joystickBase = document.getElementById("joystick-base");
const joystickThumb = document.getElementById("joystick-thumb");
const joystickZone = document.getElementById("joystick-zone");

joystickZone.addEventListener("touchstart", e => {
    e.preventDefault();
    SFX._ensureCtx();
    const touch = e.changedTouches[0];
    joystickTouch = touch.identifier;
    updateJoystick(touch);
}, { passive: false });

joystickZone.addEventListener("touchmove", e => {
    e.preventDefault();
    for (const touch of e.changedTouches) {
        if (touch.identifier === joystickTouch) updateJoystick(touch);
    }
}, { passive: false });

joystickZone.addEventListener("touchend", e => {
    for (const touch of e.changedTouches) {
        if (touch.identifier === joystickTouch) {
            joystickTouch = null;
            mobileInput.dx = 0;
            mobileInput.dy = 0;
            joystickThumb.style.transform = "translate(0, 0)";
        }
    }
});

function updateJoystick(touch) {
    const rect = joystickBase.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = touch.clientX - cx;
    let dy = touch.clientY - cy;
    const maxDist = rect.width / 2;
    const d = Math.hypot(dx, dy);
    if (d > maxDist) { dx = dx / d * maxDist; dy = dy / d * maxDist; }
    joystickThumb.style.transform = `translate(${dx}px, ${dy}px)`;
    mobileInput.dx = dx / maxDist;
    mobileInput.dy = dy / maxDist;
}

// Mobile buttons
const fireBtn = document.getElementById("btn-mobile-fire");
let mobileFireInterval = null;
fireBtn.addEventListener("touchstart", e => {
    e.preventDefault();
    mobileInput.fire = true;
    if (socket && gameState === "playing") {
        fireMobileShot();
        mobileFireInterval = setInterval(fireMobileShot, CFG.FIRE_COOLDOWN);
    }
}, { passive: false });
fireBtn.addEventListener("touchend", () => {
    mobileInput.fire = false;
    if (mobileFireInterval) { clearInterval(mobileFireInterval); mobileFireInterval = null; }
});

function fireMobileShot() {
    if (!socket || gameState !== "playing") return;
    // If carrying ball, kick toward opponent goal
    if (players[myIndex].hasBall) {
        const targetX = myIndex === 0 ? CFG.ARENA_W : 0;
        const targetY = CFG.ARENA_H / 2;
        const angle = Math.atan2(targetY - localY, targetX - localX);
        socket.emit("player_shoot", { angle });
        return;
    }
    // Otherwise shoot at opponent
    const opp = players[1 - myIndex];
    const angle = Math.atan2(opp.y - localY, opp.x - localX);
    socket.emit("player_shoot", { angle });
}

const dashBtn = document.getElementById("btn-mobile-dash");
dashBtn.addEventListener("touchstart", e => {
    e.preventDefault();
    if (socket && gameState === "playing") socket.emit("player_ability");
}, { passive: false });

// ============================================
// INPUT SENDING
// ============================================
let lastInputSend = 0;
function sendInput() {
    if (!socket || gameState !== "playing") return;
    const now = Date.now();
    if (now - lastInputSend < 1000 / CFG.TICK_RATE) return;
    lastInputSend = now;

    let dx = 0, dy = 0;
    if (isMobile) {
        dx = mobileInput.dx;
        dy = mobileInput.dy;
    } else {
        if (keys["KeyA"] || keys["ArrowLeft"]) dx = -1;
        if (keys["KeyD"] || keys["ArrowRight"]) dx = 1;
        if (keys["KeyW"] || keys["ArrowUp"]) dy = -1;
        if (keys["KeyS"] || keys["ArrowDown"]) dy = 1;
    }

    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }

    socket.emit("player_input", { dx, dy, seq: ++inputSeq });

    const speed = CFG.PLAYER_SPEED;
    localVx = dx * speed;
    localVy = dy * speed;
}

// ============================================
// RENDERING — Arena (Brawl Stars grass style)
// ============================================
function drawArena() {
    const t = Date.now() / 1000;

    // Background outside arena
    const outerGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    outerGrad.addColorStop(0, "#2a1850");
    outerGrad.addColorStop(1, "#0a0820");
    ctx.fillStyle = outerGrad;
    ctx.fillRect(0, 0, W, H);

    const tl = arenaToScreen(0, 0);
    const br = arenaToScreen(CFG.ARENA_W, CFG.ARENA_H);
    const aw = br.x - tl.x;
    const ah = br.y - tl.y;

    // Grass floor
    const grassGrad = ctx.createLinearGradient(tl.x, tl.y, br.x, br.y);
    grassGrad.addColorStop(0, "#5a9944");
    grassGrad.addColorStop(0.3, "#4a8838");
    grassGrad.addColorStop(0.5, "#4a8838");
    grassGrad.addColorStop(0.7, "#4a8838");
    grassGrad.addColorStop(1, "#5a9944");
    ctx.fillStyle = grassGrad;
    ctx.fillRect(tl.x, tl.y, aw, ah);

    // Checkerboard grass tiles
    ctx.globalAlpha = 0.1;
    const tileSize = 40 * scaleX;
    for (let gx = 0; gx < CFG.ARENA_W; gx += 40) {
        for (let gy = 0; gy < CFG.ARENA_H; gy += 40) {
            const sp = arenaToScreen(gx, gy);
            if ((Math.floor(gx / 40) + Math.floor(gy / 40)) % 2 === 0) {
                ctx.fillStyle = "#6aac54";
                ctx.fillRect(sp.x, sp.y, tileSize, tileSize);
            }
        }
    }
    ctx.globalAlpha = 1;

    // Center line
    const centerSp = arenaToScreen(CFG.ARENA_W / 2, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.15)";
    ctx.lineWidth = 2 * scaleX;
    ctx.setLineDash([8 * scaleX, 8 * scaleX]);
    ctx.beginPath();
    ctx.moveTo(centerSp.x, tl.y);
    ctx.lineTo(centerSp.x, br.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Center circle
    const cc = arenaToScreen(CFG.ARENA_W / 2, CFG.ARENA_H / 2);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2 * scaleX;
    ctx.beginPath();
    ctx.arc(cc.x, cc.y, 60 * scaleX, 0, Math.PI * 2);
    ctx.stroke();

    // Decorations
    for (const d of arenaDecorations) {
        const sp = arenaToScreen(d.x, d.y);
        const sz = d.size * scaleX;
        if (d.type === "bush") {
            ctx.fillStyle = "#2d6b1e";
            ctx.beginPath();
            ctx.arc(sp.x, sp.y + sz * 0.15, sz, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#3d8828";
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, sz * 0.85, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "#4da838";
            ctx.beginPath();
            ctx.arc(sp.x - sz * 0.2, sp.y - sz * 0.25, sz * 0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = "rgba(255,255,255,0.15)";
            ctx.beginPath();
            ctx.arc(sp.x - sz * 0.25, sp.y - sz * 0.35, sz * 0.2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            const hw = sz * 0.6;
            ctx.fillStyle = "#8b6f47";
            ctx.fillRect(sp.x - hw, sp.y - hw, hw * 2, hw * 2);
            ctx.fillStyle = "#a0824e";
            ctx.fillRect(sp.x - hw + 2, sp.y - hw + 2, hw * 2 - 4, hw - 2);
            ctx.strokeStyle = "#6b5230";
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(sp.x - hw + 3, sp.y - hw + 3);
            ctx.lineTo(sp.x + hw - 3, sp.y + hw - 3);
            ctx.moveTo(sp.x + hw - 3, sp.y - hw + 3);
            ctx.lineTo(sp.x - hw + 3, sp.y + hw - 3);
            ctx.stroke();
        }
    }

    // Walls — with goal openings
    drawWalls(tl, br, aw, ah);

    // Vignette
    ctx.globalAlpha = 0.3;
    const vigGrad = ctx.createRadialGradient(
        tl.x + aw / 2, tl.y + ah / 2, Math.min(aw, ah) * 0.4,
        tl.x + aw / 2, tl.y + ah / 2, Math.max(aw, ah) * 0.7
    );
    vigGrad.addColorStop(0, "rgba(0,0,0,0)");
    vigGrad.addColorStop(1, "rgba(0,0,0,0.5)");
    ctx.fillStyle = vigGrad;
    ctx.fillRect(tl.x, tl.y, aw, ah);
    ctx.globalAlpha = 1;
}

// ============================================
// RENDERING — Walls with Goal Openings
// ============================================
function drawWalls(tl, br, aw, ah) {
    const wallW = 10 * scaleX;
    const goalTop = (CFG.ARENA_H - CFG.GOAL_WIDTH) / 2;
    const goalBottom = goalTop + CFG.GOAL_WIDTH;
    const gtScreen = arenaToScreen(0, goalTop);
    const gbScreen = arenaToScreen(0, goalBottom);
    const goalTopY = gtScreen.y;
    const goalBottomY = gbScreen.y;

    // Top wall (full width)
    ctx.fillStyle = "#1a3a6a";
    ctx.fillRect(tl.x - wallW, tl.y - wallW, aw + wallW * 2, wallW);
    ctx.fillStyle = "#2a5a9a";
    ctx.fillRect(tl.x - wallW / 2, tl.y - wallW / 2, aw + wallW, wallW / 2);

    // Bottom wall (full width)
    ctx.fillStyle = "#1a3a6a";
    ctx.fillRect(tl.x - wallW, br.y, aw + wallW * 2, wallW);
    ctx.fillStyle = "#2a5a9a";
    ctx.fillRect(tl.x - wallW / 2, br.y, aw + wallW, wallW / 2);

    // Left wall — with goal gap
    ctx.fillStyle = "#1a3a6a";
    // Top portion
    ctx.fillRect(tl.x - wallW, tl.y, wallW, goalTopY - tl.y);
    // Bottom portion
    ctx.fillRect(tl.x - wallW, goalBottomY, wallW, br.y - goalBottomY);

    // Right wall — with goal gap
    ctx.fillStyle = "#1a3a6a";
    ctx.fillRect(br.x, tl.y, wallW, goalTopY - tl.y);
    ctx.fillRect(br.x, goalBottomY, wallW, br.y - goalBottomY);

    // Inner highlights
    ctx.fillStyle = "#4a8acc";
    ctx.fillRect(tl.x, tl.y, aw, 3 * scaleY);
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(tl.x, br.y - 3 * scaleY, aw, 3 * scaleY);

    // Corner bolts
    const boltR = 6 * scaleX;
    const corners = [[tl.x, tl.y], [br.x, tl.y], [tl.x, br.y], [br.x, br.y]];
    for (const [cx, cy] of corners) {
        ctx.fillStyle = "#ffd700";
        ctx.shadowColor = "#ffaa00";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(cx, cy, boltR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#ffeeaa";
        ctx.beginPath();
        ctx.arc(cx - boltR * 0.2, cy - boltR * 0.2, boltR * 0.4, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

// ============================================
// RENDERING — Goals
// ============================================
function drawGoals() {
    const goalTop = (CFG.ARENA_H - CFG.GOAL_WIDTH) / 2;
    const goalBottom = goalTop + CFG.GOAL_WIDTH;
    const depth = CFG.GOAL_DEPTH;

    // Left goal (P0 defends) — orange tint
    drawGoal(0, goalTop, goalBottom, depth, "rgba(255,140,40,", -1);
    // Right goal (P1 defends) — blue tint
    drawGoal(CFG.ARENA_W, goalTop, goalBottom, depth, "rgba(40,140,255,", 1);
}

function drawGoal(wallX, goalTop, goalBottom, depth, colorBase, dir) {
    // dir: -1 = left goal (extends left), 1 = right goal (extends right)
    const gt = arenaToScreen(wallX, goalTop);
    const gb = arenaToScreen(wallX, goalBottom);
    const goalDepthPx = depth * scaleX;
    const goalWidthPx = gb.y - gt.y;

    // Goal area fill (net background)
    const gx = dir === -1 ? gt.x - goalDepthPx : gt.x;
    ctx.fillStyle = colorBase + "0.15)";
    ctx.fillRect(gx, gt.y, goalDepthPx, goalWidthPx);

    // Net pattern (horizontal lines)
    ctx.strokeStyle = colorBase + "0.25)";
    ctx.lineWidth = 1;
    const netSpacing = 10 * scaleY;
    for (let y = gt.y; y <= gb.y; y += netSpacing) {
        ctx.beginPath();
        ctx.moveTo(gx, y);
        ctx.lineTo(gx + goalDepthPx, y);
        ctx.stroke();
    }
    // Vertical lines
    const vNetSpacing = 10 * scaleX;
    for (let x = gx; x <= gx + goalDepthPx; x += vNetSpacing) {
        ctx.beginPath();
        ctx.moveTo(x, gt.y);
        ctx.lineTo(x, gb.y);
        ctx.stroke();
    }

    // Goal posts (white thick lines at top and bottom of opening)
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4 * scaleX;
    ctx.shadowColor = "#ffffff";
    ctx.shadowBlur = 8;

    // Top post
    ctx.beginPath();
    ctx.moveTo(gt.x, gt.y);
    ctx.lineTo(gx, gt.y);
    ctx.stroke();

    // Bottom post
    ctx.beginPath();
    ctx.moveTo(gb.x, gb.y);
    ctx.lineTo(gx, gb.y);
    ctx.stroke();

    // Back post
    ctx.beginPath();
    ctx.moveTo(gx, gt.y);
    ctx.lineTo(gx, gb.y);
    ctx.stroke();

    ctx.shadowBlur = 0;

    // Goal glow
    ctx.globalAlpha = 0.1 + Math.sin(Date.now() / 500) * 0.05;
    ctx.fillStyle = colorBase + "0.3)";
    ctx.fillRect(gx, gt.y, goalDepthPx, goalWidthPx);
    ctx.globalAlpha = 1;
}

// ============================================
// RENDERING — Ball
// ============================================
function drawBall() {
    const t = Date.now() / 1000;

    if (ball.carrier !== -1) {
        // Ball is carried — draw golden ring around carrier
        const carrierIdx = ball.carrier;
        const isMe = carrierIdx === myIndex;
        const px = isMe ? localX : players[carrierIdx].x;
        const py = isMe ? localY : players[carrierIdx].y;
        const sp = arenaToScreen(px, py);
        const r = CFG.PLAYER_RADIUS * scaleX;

        ctx.strokeStyle = "#ffd700";
        ctx.lineWidth = 3 * scaleX;
        ctx.shadowColor = "#ffd700";
        ctx.shadowBlur = 12;
        ctx.globalAlpha = 0.6 + Math.sin(t * 6) * 0.2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 1.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1;
        return;
    }

    // Free ball
    const sp = arenaToScreen(ball.x, ball.y);
    const r = CFG.BALL_RADIUS * scaleX;
    const speed = Math.hypot(ball.vx, ball.vy);

    // Speed trail particles
    if (speed > 50 && Math.random() < 0.5) {
        spawnParticle(ball.x + (Math.random() - 0.5) * 6, ball.y + (Math.random() - 0.5) * 6,
            -ball.vx * 0.1 + (Math.random() - 0.5) * 20, -ball.vy * 0.1 + (Math.random() - 0.5) * 20,
            0.2 + Math.random() * 0.15, "#ffd700", 1.5 + Math.random() * 1.5);
    }

    // Shadow
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y + r * 0.6, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Glow
    ctx.shadowColor = "#ffd700";
    ctx.shadowBlur = 15;

    // Ball body — white/gold soccer ball
    const ballGrad = ctx.createRadialGradient(sp.x - r * 0.3, sp.y - r * 0.3, 0, sp.x, sp.y, r);
    ballGrad.addColorStop(0, "#ffffff");
    ballGrad.addColorStop(0.5, "#fff8e0");
    ballGrad.addColorStop(1, "#ffd700");
    ctx.fillStyle = ballGrad;
    ctx.beginPath();
    ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
    ctx.fill();

    // Pentagon pattern on ball
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(0,0,0,0.2)";
    ctx.lineWidth = 1;
    const spin = t * 3;
    for (let i = 0; i < 5; i++) {
        const angle = spin + (i / 5) * Math.PI * 2;
        const px = sp.x + Math.cos(angle) * r * 0.5;
        const py = sp.y + Math.sin(angle) * r * 0.5;
        ctx.beginPath();
        ctx.arc(px, py, r * 0.25, 0, Math.PI * 2);
        ctx.stroke();
    }

    // Highlight
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.beginPath();
    ctx.arc(sp.x - r * 0.25, sp.y - r * 0.25, r * 0.3, 0, Math.PI * 2);
    ctx.fill();
}

// ============================================
// RENDERING — Player
// ============================================
function drawPlayer(index) {
    const isMe = index === myIndex;
    const px = isMe ? localX : players[index].x;
    const py = isMe ? localY : players[index].y;
    const p = players[index];

    if (!p.alive) {
        // Draw gray X at death position
        const sp = arenaToScreen(px, py);
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = "#888";
        ctx.lineWidth = 3 * scaleX;
        const sz = CFG.PLAYER_RADIUS * scaleX * 0.6;
        ctx.beginPath();
        ctx.moveTo(sp.x - sz, sp.y - sz);
        ctx.lineTo(sp.x + sz, sp.y + sz);
        ctx.moveTo(sp.x + sz, sp.y - sz);
        ctx.lineTo(sp.x - sz, sp.y + sz);
        ctx.stroke();
        ctx.globalAlpha = 1;
        return;
    }

    const sp = arenaToScreen(px, py);
    const r = CFG.PLAYER_RADIUS * scaleX;
    const t = Date.now() / 1000;

    const isMoving = isMe ? (Math.abs(localVx) > 1 || Math.abs(localVy) > 1) : false;
    if (isMoving) moveTime += 0.05;

    // Drop shadow
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y + r * 0.8, r * 1.0, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Glow ring
    ctx.save();
    const glowColor = index === 0 ? "rgba(255, 102, 34, 0.4)" : "rgba(0, 136, 255, 0.4)";
    ctx.globalAlpha = 0.3 + Math.sin(t * 3) * 0.1;
    ctx.strokeStyle = glowColor;
    ctx.lineWidth = 2 * scaleX;
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y + r * 0.6, r * 1.1, r * 0.4, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.translate(sp.x, sp.y);

    if (hitFlash[index] > 0) {
        ctx.globalAlpha = 0.5 + Math.sin(hitFlash[index] * 30) * 0.5;
    }

    const bounceY = isMoving ? Math.sin(moveTime * 8) * 3 * scaleY : 0;
    const bounceScale = isMoving ? 1 + Math.sin(moveTime * 8) * 0.04 : 1;
    const bob = Math.sin(t * 2.5 + index * Math.PI) * 2 * scaleY;
    ctx.translate(0, bob + bounceY);
    ctx.scale(bounceScale, bounceScale);

    // Facing direction
    const base = index === 0 ? "k1" : "k2";
    let vx = 0, vy = 0;
    if (isMe) {
        vx = localVx; vy = localVy;
    } else if (players[index].targetX !== undefined) {
        vx = players[index].targetX - players[index].x;
        vy = players[index].targetY - players[index].y;
    }
    if (Math.abs(vx) > 1 || Math.abs(vy) > 1) {
        if (Math.abs(vx) > Math.abs(vy)) {
            playerDir[index] = vx > 0 ? "right" : "left";
        } else {
            playerDir[index] = vy > 0 ? "front" : "back";
        }
    }

    const dirSprite = sprites[`${base}_${playerDir[index]}`];
    const legacySprite = sprites[base];
    const activeSprite = dirSprite || legacySprite;

    if (activeSprite) {
        const size = r * 3;
        ctx.drawImage(activeSprite, -size / 2, -size / 2, size, size);
    } else {
        const fallGrad = ctx.createRadialGradient(0, -r * 0.3, 0, 0, 0, r);
        if (index === 0) {
            fallGrad.addColorStop(0, "#ffaa44");
            fallGrad.addColorStop(1, "#ff6622");
        } else {
            fallGrad.addColorStop(0, "#66bbff");
            fallGrad.addColorStop(1, "#0088ff");
        }
        ctx.fillStyle = fallGrad;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();

    // Weapon indicator ring
    if (p.weapon) {
        let weaponColor;
        if (p.weapon === "fast") weaponColor = "#44ff44";
        else if (p.weapon === "laser") weaponColor = "#ff44ff";
        else weaponColor = "#ff4444";

        ctx.save();
        ctx.strokeStyle = weaponColor;
        ctx.lineWidth = 2.5 * scaleX;
        ctx.shadowColor = weaponColor;
        ctx.shadowBlur = 10;
        ctx.globalAlpha = 0.7 + Math.sin(Date.now() / 200) * 0.2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.restore();
    }

    // Health bar (smaller)
    ctx.globalAlpha = 1;
    const hpW = 36 * scaleX;
    const hpH = 4 * scaleY;
    const hpX = sp.x - hpW / 2;
    const hpY = sp.y - r * 1.5 - 8 * scaleY + (Math.sin(t * 2.5 + index * Math.PI) * 2 * scaleY);
    const hpFrac = Math.max(0, p.hp / CFG.PLAYER_HP);

    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const hpBorderR = 2 * scaleX;
    ctx.beginPath();
    ctx.roundRect(hpX - 1, hpY - 1, hpW + 2, hpH + 2, hpBorderR);
    ctx.fill();

    if (hpFrac > 0) {
        const hpGrad = ctx.createLinearGradient(hpX, hpY, hpX + hpW * hpFrac, hpY);
        if (isMe) {
            hpGrad.addColorStop(0, "#00cc44");
            hpGrad.addColorStop(1, "#44ff88");
        } else {
            hpGrad.addColorStop(0, "#cc0022");
            hpGrad.addColorStop(1, "#ff4466");
        }
        ctx.fillStyle = hpGrad;
        ctx.beginPath();
        ctx.roundRect(hpX, hpY, hpW * hpFrac, hpH, hpBorderR);
        ctx.fill();
    }
}

// ============================================
// RENDERING — Bullets
// ============================================
function drawBullets() {
    for (const b of bullets) {
        const sp = arenaToScreen(b.x, b.y);
        const r = CFG.BULLET_RADIUS * scaleX;
        const isMyBullet = b.owner === myIndex;
        const wt = b.weaponType;

        // Weapon-specific trail colors
        let trailColor, glowColor;
        if (wt === "fast") {
            trailColor = "#44ff44";
            glowColor = "#44ff44";
        } else if (wt === "laser") {
            trailColor = "#ff44ff";
            glowColor = "#ff44ff";
        } else if (wt === "bomb") {
            trailColor = "#ff4444";
            glowColor = "#ff4444";
        } else {
            trailColor = isMyBullet ? "#ff8800" : "#4488ff";
            glowColor = trailColor;
        }

        if (Math.random() < 0.4) {
            spawnParticle(b.x + (Math.random() - 0.5) * 4, b.y + (Math.random() - 0.5) * 4,
                (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
                0.15 + Math.random() * 0.1, trailColor, 1.5 + Math.random() * 1.5);
        }

        ctx.shadowColor = glowColor;
        ctx.shadowBlur = wt === "laser" ? 18 : 12;

        // Laser: draw as elongated line
        if (wt === "laser") {
            ctx.strokeStyle = "#ff88ff";
            ctx.lineWidth = r * 2.5;
            ctx.globalAlpha = 0.8;
            ctx.beginPath();
            ctx.moveTo(sp.x - Math.cos(Math.atan2(b.vy || 0, b.vx || 0)) * r * 4, sp.y - Math.sin(Math.atan2(b.vy || 0, b.vx || 0)) * r * 4);
            ctx.lineTo(sp.x + Math.cos(Math.atan2(b.vy || 0, b.vx || 0)) * r * 4, sp.y + Math.sin(Math.atan2(b.vy || 0, b.vx || 0)) * r * 4);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.shadowBlur = 0;
            continue;
        }

        // Bomb: larger circle
        const drawR = wt === "bomb" ? r * 2 : r * 1.2;

        const bulGrad = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, drawR);
        if (wt === "fast") {
            bulGrad.addColorStop(0, "#fff");
            bulGrad.addColorStop(0.3, "#88ff88");
            bulGrad.addColorStop(1, "#22aa22");
        } else if (wt === "bomb") {
            bulGrad.addColorStop(0, "#fff");
            bulGrad.addColorStop(0.3, "#ff8844");
            bulGrad.addColorStop(1, "#cc2200");
        } else if (isMyBullet) {
            bulGrad.addColorStop(0, "#fff");
            bulGrad.addColorStop(0.3, "#ffcc44");
            bulGrad.addColorStop(1, "#ff6600");
        } else {
            bulGrad.addColorStop(0, "#fff");
            bulGrad.addColorStop(0.3, "#88ccff");
            bulGrad.addColorStop(1, "#0066ff");
        }
        ctx.fillStyle = bulGrad;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, drawR, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

// ============================================
// RENDERING — Dash trails
// ============================================
function drawDashTrails(dt) {
    for (let i = dashTrail.length - 1; i >= 0; i--) {
        const trail = dashTrail[i];
        trail.alpha -= dt * 3;
        if (trail.alpha <= 0) {
            dashTrail.splice(i, 1);
            continue;
        }
        const sp = arenaToScreen(trail.x, trail.y);
        const r = CFG.PLAYER_RADIUS * scaleX;
        ctx.globalAlpha = trail.alpha * 0.5;

        if (trail.color) {
            ctx.fillStyle = trail.color;
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, r * 0.8, 0, Math.PI * 2);
            ctx.fill();
        }

        const base = trail.index === 0 ? "k1" : "k2";
        const trailSprite = sprites[`${base}_${playerDir[trail.index]}`] || sprites[base];
        if (trailSprite) {
            const size = r * 3;
            ctx.drawImage(trailSprite, sp.x - size / 2, sp.y - size / 2, size, size);
        }
    }
    ctx.globalAlpha = 1;
}

// ============================================
// RENDERING — Obstacles
// ============================================
function drawObstacles() {
    for (const obs of obstacles) {
        const sp = arenaToScreen(obs.x, obs.y);
        const r = obs.r * scaleX;

        // Shadow
        ctx.globalAlpha = 0.3;
        ctx.fillStyle = "rgba(0,0,0,0.4)";
        ctx.beginPath();
        ctx.ellipse(sp.x + 2 * scaleX, sp.y + 3 * scaleX, r, r * 0.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Rock body gradient
        const rockGrad = ctx.createRadialGradient(sp.x - r * 0.3, sp.y - r * 0.3, 0, sp.x, sp.y, r);
        rockGrad.addColorStop(0, "#9a9a9a");
        rockGrad.addColorStop(0.5, "#777777");
        rockGrad.addColorStop(1, "#555555");
        ctx.fillStyle = rockGrad;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Highlight
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.beginPath();
        ctx.arc(sp.x - r * 0.25, sp.y - r * 0.25, r * 0.35, 0, Math.PI * 2);
        ctx.fill();

        // Dark edge
        ctx.strokeStyle = "rgba(0,0,0,0.3)";
        ctx.lineWidth = 2 * scaleX;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.stroke();
    }
}

// ============================================
// RENDERING — Goalkeepers
// ============================================
function drawGoalkeepers() {
    const t = Date.now() / 1000;
    for (const gk of goalkeepers) {
        const sp = arenaToScreen(gk.x, gk.y);
        const r = 18 * scaleX; // GK_RADIUS

        // Pulsing ring
        ctx.strokeStyle = gk.team === 0 ? "rgba(255,140,40,0.5)" : "rgba(40,140,255,0.5)";
        ctx.lineWidth = 2 * scaleX;
        ctx.globalAlpha = 0.4 + Math.sin(t * 4) * 0.2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 1.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Body
        const gkGrad = ctx.createRadialGradient(sp.x - r * 0.2, sp.y - r * 0.2, 0, sp.x, sp.y, r);
        if (gk.team === 0) {
            gkGrad.addColorStop(0, "#ffcc66");
            gkGrad.addColorStop(1, "#ff8822");
        } else {
            gkGrad.addColorStop(0, "#88ccff");
            gkGrad.addColorStop(1, "#2266ff");
        }
        ctx.fillStyle = gkGrad;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();

        // Border
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        ctx.lineWidth = 2 * scaleX;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.stroke();

        // "GK" text
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.round(10 * scaleX)}px Orbitron, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("GK", sp.x, sp.y);
    }
}

// ============================================
// RENDERING — Weapons on field
// ============================================
function drawWeapons() {
    const t = Date.now() / 1000;
    for (const w of weapons) {
        const sp = arenaToScreen(w.x, w.y);
        const r = 12 * scaleX;

        // Glow
        let glowColor, bodyColor;
        if (w.type === "fast") {
            glowColor = "#44ff44";
            bodyColor = "#22cc22";
        } else if (w.type === "laser") {
            glowColor = "#ff44ff";
            bodyColor = "#cc22cc";
        } else {
            glowColor = "#ff4444";
            bodyColor = "#cc2222";
        }

        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 12 + Math.sin(t * 5) * 4;

        ctx.fillStyle = bodyColor;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Inner highlight
        ctx.fillStyle = glowColor;
        ctx.globalAlpha = 0.5 + Math.sin(t * 5) * 0.2;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * 0.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;

        // Label
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${Math.round(8 * scaleX)}px Orbitron, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const label = w.type === "fast" ? "F" : w.type === "laser" ? "L" : "B";
        ctx.fillText(label, sp.x, sp.y);
    }
}

// ============================================
// RENDERING — Bomb explosions (visual)
// ============================================
function drawBombExplosions(dt) {
    for (let i = bombExplosions.length - 1; i >= 0; i--) {
        const e = bombExplosions[i];
        e.alpha -= dt * 3;
        if (e.alpha <= 0) { bombExplosions.splice(i, 1); continue; }
        const sp = arenaToScreen(e.x, e.y);
        const r = e.radius * scaleX;
        ctx.globalAlpha = e.alpha * 0.4;
        ctx.fillStyle = "#ff4400";
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#ffaa00";
        ctx.lineWidth = 3 * scaleX;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r * e.alpha, 0, Math.PI * 2);
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function drawAimLine() {
    if (isMobile || gameState !== "playing") return;
    const sp = arenaToScreen(localX, localY);
    const lineLen = 50 * scaleX;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.2)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(sp.x + Math.cos(aimAngle) * lineLen, sp.y + Math.sin(aimAngle) * lineLen);
    ctx.stroke();
    ctx.setLineDash([]);
}

// ============================================
// HUD UPDATE
// ============================================
function updateHUD() {
    const me = players[myIndex];

    // Score display
    const scoreEl = document.getElementById("score-display");
    if (scoreEl) scoreEl.textContent = `${score[0]}  -  ${score[1]}`;

    // Timer
    const timerEl = document.getElementById("match-timer");
    if (timerEl) timerEl.textContent = formatTime(matchTimer);

    // Overtime indicator
    const otEl = document.getElementById("overtime-indicator");
    if (otEl) {
        if (overtime) {
            otEl.classList.remove("hidden");
        } else {
            otEl.classList.add("hidden");
        }
    }

    // Ball indicator
    const ballEl = document.getElementById("ball-indicator");
    if (ballEl) {
        if (me.hasBall) {
            ballEl.classList.remove("hidden");
        } else {
            ballEl.classList.add("hidden");
        }
    }

    // Dash indicator
    const dashEl = document.getElementById("dash-indicator");
    if (me.dashCooldown > 0) {
        dashEl.textContent = `DASH ${(me.dashCooldown / 1000).toFixed(1)}s`;
        dashEl.classList.add("on-cooldown");
    } else {
        dashEl.textContent = "DASH READY";
        dashEl.classList.remove("on-cooldown");
    }

    // Weapon indicator
    const weaponEl = document.getElementById("weapon-indicator");
    if (weaponEl) {
        if (me.weapon) {
            const timer = me.weaponTimer ? (me.weaponTimer / 1000).toFixed(1) : "";
            const names = { fast: "FAST", laser: "LASER", bomb: "BOMB" };
            weaponEl.textContent = `${names[me.weapon] || me.weapon} ${timer}s`;
            weaponEl.classList.remove("hidden");
            weaponEl.className = `weapon-indicator weapon-${me.weapon}`;
        } else {
            weaponEl.classList.add("hidden");
        }
    }

    // Mobile fire button label
    if (isMobile) {
        const fb = document.getElementById("btn-mobile-fire");
        if (fb) fb.textContent = me.hasBall ? "KICK" : "FIRE";
    }
}

// ============================================
// GAME LOOP
// ============================================
let lastFrame = 0;
const TARGET_FPS = 30;
const FRAME_TIME = 1000 / TARGET_FPS;

function gameLoop(timestamp) {
    requestAnimationFrame(gameLoop);

    const elapsed = timestamp - lastFrame;
    if (elapsed < FRAME_TIME * 0.9) return;
    lastFrame = timestamp;
    const dt = Math.min(elapsed / 1000, 0.1);

    if (gameState === "playing") {
        sendInput();

        // Local prediction
        localX += localVx * dt;
        localY += localVy * dt;
        localX = clamp(localX, CFG.PLAYER_RADIUS, CFG.ARENA_W - CFG.PLAYER_RADIUS);
        localY = clamp(localY, CFG.PLAYER_RADIUS, CFG.ARENA_H - CFG.PLAYER_RADIUS);

        // Local obstacle collision prediction
        for (const obs of obstacles) {
            const dx = localX - obs.x;
            const dy = localY - obs.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            const minDist = CFG.PLAYER_RADIUS + obs.r;
            if (dist < minDist && dist > 0) {
                const nx = dx / dist;
                const ny = dy / dist;
                localX = obs.x + nx * minDist;
                localY = obs.y + ny * minDist;
            }
        }

        // Interpolate remote player
        const other = 1 - myIndex;
        if (players[other].targetX !== undefined) {
            players[other].x = lerp(players[other].x, players[other].targetX, 0.2);
            players[other].y = lerp(players[other].y, players[other].targetY, 0.2);
        }

        // Update hit flash
        for (let i = 0; i < 2; i++) {
            if (hitFlash[i] > 0) hitFlash[i] -= dt;
        }

        // Goal flash decay
        if (goalFlash > 0) goalFlash -= dt * 2;

        updateParticles(dt);
        updateAimAngle();
        updateHUD();
    }

    render(dt);
}

function render(dt) {
    ctx.clearRect(0, 0, W * 2, H * 2);

    if (gameState === "playing" || gameState === "gameover") {
        drawArena();
        drawGoals();
        drawObstacles();
        drawWeapons();
        drawGoalkeepers();
        drawDashTrails(dt);

        // Draw players (remote first, local on top)
        drawPlayer(1 - myIndex);
        drawPlayer(myIndex);

        drawBall();
        drawBullets();
        drawBombExplosions(dt);
        drawParticles();
        drawAimLine();

        // Goal flash overlay
        if (goalFlash > 0) {
            ctx.globalAlpha = goalFlash * 0.3;
            ctx.fillStyle = "#ffd700";
            ctx.fillRect(0, 0, W, H);
            ctx.globalAlpha = 1;
        }
    }
}

// ============================================
// UI EVENTS
// ============================================
document.getElementById("btn-create").addEventListener("click", () => {
    SFX.click();
    connectSocket();
    socket.emit("create_room");
});

document.getElementById("btn-join").addEventListener("click", () => {
    SFX.click();
    const code = document.getElementById("room-code-input").value.trim().toUpperCase();
    if (code.length !== 4) {
        showError("Enter a 4-character room code");
        return;
    }
    connectSocket();
    socket.emit("join_room", { code });
});

document.getElementById("btn-quick").addEventListener("click", () => {
    SFX.click();
    connectSocket();
    socket.emit("quick_match");
});

document.getElementById("btn-solo").addEventListener("click", () => {
    SFX.click();
    connectSocket();
    socket.emit("start_solo");
});

document.getElementById("btn-cancel").addEventListener("click", () => {
    SFX.click();
    if (socket) {
        socket.emit("cancel_queue");
        socket.disconnect();
        socket = null;
    }
    showScreen("title-screen");
    gameState = "title";
});

document.getElementById("btn-restart").addEventListener("click", () => {
    SFX.click();
    stopConfetti();
    if (socket && socket.connected) {
        socket.emit("restart_request");
        const rs = document.getElementById("restart-status");
        rs.textContent = "Waiting for opponent...";
        rs.classList.remove("hidden");
    }
});

document.getElementById("btn-menu").addEventListener("click", () => {
    SFX.click();
    Music.stop();
    stopConfetti();
    if (socket) { socket.disconnect(); socket = null; }
    showScreen("title-screen");
    gameState = "title";
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("mobile-controls").classList.add("hidden");
});

document.getElementById("room-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-join").click();
});

document.getElementById("btn-how-to-play").addEventListener("click", () => {
    SFX.click();
    document.getElementById("how-to-play-modal").classList.remove("hidden");
});

document.getElementById("btn-close-guide").addEventListener("click", () => {
    SFX.click();
    document.getElementById("how-to-play-modal").classList.add("hidden");
});

// ============================================
// INIT
// ============================================
function init() {
    resize();
    detectMobile();
    loadSprites();
    generateDecorations();
    showScreen("title-screen");
    requestAnimationFrame(gameLoop);
}

window.addEventListener("resize", () => {
    resize();
    detectMobile();
});

init();

})();
