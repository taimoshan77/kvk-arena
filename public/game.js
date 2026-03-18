// ============================================
// K vs K — Game Client (Brawl Stars Style)
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
    POWERUP_RADIUS: 15,
    POWERUP_DURATION: 8000,
    TICK_RATE: 20,
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
    powerup() {
        const c = this._ensureCtx();
        [523, 659, 784, 1047].forEach((freq, i) => {
            const o = c.createOscillator();
            const g = c.createGain();
            o.type = "sine"; o.frequency.value = freq;
            const t = c.currentTime + i * 0.06;
            g.gain.setValueAtTime(0.08, t);
            g.gain.linearRampToValueAtTime(0, t + 0.1);
            o.connect(g).connect(c.destination);
            o.start(t); o.stop(t + 0.1);
        });
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
// MUSIC — Audio file BGM (CC0 "Urban Boss Battle")
// ============================================
const Music = {
    audio: null,
    playing: false,

    start() {
        if (this.playing) return;
        SFX._ensureCtx();
        if (!this.audio) {
            this.audio = new Audio();
            // Try OGG first, fallback to MP3
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
    { x: 200, y: 450, hp: 100, alive: true, powerup: null, dashCooldown: 0 },
    { x: 600, y: 150, hp: 100, alive: true, powerup: null, dashCooldown: 0 },
];
let bullets = [];
let powerups = [];

// Local input
const keys = {};
const mobileInput = { dx: 0, dy: 0, fire: false, dash: false };

// Local movement prediction
let localX = 200, localY = 450;
let localVx = 0, localVy = 0;

// Interpolation
let prevState = null;
let currState = null;
let stateTime = 0;
const INTERP_DELAY = 50; // ms

// Sprites (directional: front, back, left, right)
const sprites = {
    k1: null, k2: null, // legacy (title screen)
    k1_front: null, k1_back: null, k1_left: null, k1_right: null,
    k2_front: null, k2_back: null, k2_left: null, k2_right: null,
};
let spritesLoaded = 0;
// Track each player's facing direction
let playerDir = ["front", "front"];

// Particles
const particlePool = [];
const activeParticles = [];

// Animation state
let hitFlash = [0, 0]; // flash timer per player
let dashTrail = [];     // {x, y, alpha, index}
let moveTime = 0;       // for bounce animation

// Aiming
let aimAngle = 0;
let mouseX = 0, mouseY = 0;

// Arena decorations (generated once)
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

    // Fit arena (800x600) into viewport with letterboxing
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

// ============================================
// SPRITES
// ============================================
function loadSprites() {
    // Title screen sprites
    ["k1", "k2"].forEach(name => {
        const img = new Image();
        img.onload = () => { sprites[name] = img; spritesLoaded++; };
        img.src = `/assets/${name}.png`;
    });
    // Directional 3D sprites
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
    // Bushes in clusters (corners and edges, away from center)
    for (let i = 0; i < 8; i++) {
        const margin = 60;
        let x, y;
        // Place near edges, avoid center area
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
    // Crates (scattered)
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
            { x: 200, y: 450, hp: CFG.PLAYER_HP, alive: true, powerup: null, dashCooldown: 0 },
            { x: 600, y: 150, hp: CFG.PLAYER_HP, alive: true, powerup: null, dashCooldown: 0 },
        ];
        bullets = [];
        powerups = [];
        hitFlash = [0, 0];
        dashTrail = [];
        activeParticles.length = 0;
        moveTime = 0;
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

        notify("FIGHT!", "big");
        resize();

        // Start background music
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
            players[i].powerup = sp.powerup;
            players[i].dashCooldown = sp.dashCooldown;

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

    socket.on("powerup_spawn", (pu) => {
        powerups.push(pu);
    });

    socket.on("powerup_pickup", (data) => {
        powerups = powerups.filter(p => p.id !== data.id);
        SFX.powerup();
        if (data.player === myIndex) {
            const labels = { speed: "SPEED BOOST!", rapid: "RAPID FIRE!", health: "+30 HP!" };
            notify(labels[data.type] || data.type, "powerup");
        }
    });

    socket.on("player_dash", (data) => {
        SFX.dash();
        // Rainbow dash trail
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

        Music.stop();

        if (isWinner) { SFX.win(); } else { SFX.lose(); }

        const titleEl = document.getElementById("result-title");
        titleEl.textContent = isWinner ? "YOU WIN!" : "YOU LOSE";
        titleEl.className = "screen-title result-title " + (isWinner ? "win" : "lose");

        document.getElementById("result-my-hp").textContent = Math.max(0, Math.round(players[myIndex].hp));
        document.getElementById("result-opp-hp").textContent = Math.max(0, Math.round(players[1 - myIndex].hp));
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
            document.getElementById("result-my-hp").textContent = Math.round(players[myIndex].hp);
            document.getElementById("result-opp-hp").textContent = "DC";
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

    let speed = CFG.PLAYER_SPEED;
    if (players[myIndex].powerup === "speed") speed *= 1.5;
    localVx = dx * speed;
    localVy = dy * speed;
}

// ============================================
// RENDERING — Arena (Brawl Stars grass style)
// ============================================
function drawArena() {
    const t = Date.now() / 1000;

    // Colorful background outside arena (Brawl Stars blue/purple)
    const outerGrad = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
    outerGrad.addColorStop(0, "#2a1850");
    outerGrad.addColorStop(1, "#0a0820");
    ctx.fillStyle = outerGrad;
    ctx.fillRect(0, 0, W, H);

    const tl = arenaToScreen(0, 0);
    const br = arenaToScreen(CFG.ARENA_W, CFG.ARENA_H);
    const aw = br.x - tl.x;
    const ah = br.y - tl.y;

    // Sandy/grass floor — Brawl Stars warm palette
    const grassGrad = ctx.createLinearGradient(tl.x, tl.y, br.x, br.y);
    grassGrad.addColorStop(0, "#5a9944");
    grassGrad.addColorStop(0.3, "#4a8838");
    grassGrad.addColorStop(0.5, "#d4a853"); // sandy center path
    grassGrad.addColorStop(0.7, "#4a8838");
    grassGrad.addColorStop(1, "#5a9944");
    ctx.fillStyle = grassGrad;
    ctx.fillRect(tl.x, tl.y, aw, ah);

    // Checkerboard grass tiles (alternating greens)
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

    // Center diamond decoration (like Brawl Stars maps)
    const cx = tl.x + aw / 2;
    const cy = tl.y + ah / 2;
    ctx.globalAlpha = 0.08;
    ctx.fillStyle = "#ffd700";
    ctx.beginPath();
    ctx.moveTo(cx, cy - 80 * scaleY);
    ctx.lineTo(cx + 80 * scaleX, cy);
    ctx.lineTo(cx, cy + 80 * scaleY);
    ctx.lineTo(cx - 80 * scaleX, cy);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Decorations (bushes, rocks, flowers, crates)
    for (const d of arenaDecorations) {
        const sp = arenaToScreen(d.x, d.y);
        const sz = d.size * scaleX;
        if (d.type === "bush") {
            // Multi-layered bush
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
            // Highlight dot
            ctx.fillStyle = "rgba(255,255,255,0.15)";
            ctx.beginPath();
            ctx.arc(sp.x - sz * 0.25, sp.y - sz * 0.35, sz * 0.2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Crate/rock with Brawl Stars style
            const hw = sz * 0.6;
            ctx.fillStyle = "#8b6f47";
            ctx.fillRect(sp.x - hw, sp.y - hw, hw * 2, hw * 2);
            ctx.fillStyle = "#a0824e";
            ctx.fillRect(sp.x - hw + 2, sp.y - hw + 2, hw * 2 - 4, hw - 2);
            // X on crate
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

    // Thick 3D beveled wall border (Brawl Stars blue walls)
    const wallW = 10 * scaleX;
    // Outer wall (dark blue)
    ctx.fillStyle = "#1a3a6a";
    ctx.fillRect(tl.x - wallW, tl.y - wallW, aw + wallW * 2, wallW);
    ctx.fillRect(tl.x - wallW, br.y, aw + wallW * 2, wallW);
    ctx.fillRect(tl.x - wallW, tl.y, wallW, ah);
    ctx.fillRect(br.x, tl.y, wallW, ah);
    // Mid wall (medium blue)
    const wallW2 = 5 * scaleX;
    ctx.fillStyle = "#2a5a9a";
    ctx.fillRect(tl.x - wallW2, tl.y - wallW2, aw + wallW2 * 2, wallW2);
    ctx.fillRect(tl.x - wallW2, br.y, aw + wallW2 * 2, wallW2);
    ctx.fillRect(tl.x - wallW2, tl.y, wallW2, ah);
    ctx.fillRect(br.x, tl.y, wallW2, ah);
    // Inner highlight
    ctx.fillStyle = "#4a8acc";
    ctx.fillRect(tl.x, tl.y, aw, 3 * scaleY);
    ctx.fillRect(tl.x, tl.y, 3 * scaleX, ah);
    // Inner shadow
    ctx.fillStyle = "rgba(0,0,0,0.25)";
    ctx.fillRect(tl.x, br.y - 3 * scaleY, aw, 3 * scaleY);
    ctx.fillRect(br.x - 3 * scaleX, tl.y, 3 * scaleX, ah);

    // Corner bolts (gold circles at corners — Brawl Stars style)
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

    // Vignette around edges
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
// RENDERING — Powerups (colorful, bouncing, spinning)
// ============================================
function drawPowerups() {
    const t = Date.now() / 1000;
    for (const pu of powerups) {
        const sp = arenaToScreen(pu.x, pu.y);
        const r = CFG.POWERUP_RADIUS * scaleX;
        const bob = Math.sin(t * 3 + pu.id) * 4 * scaleY;
        const spin = t * 2 + pu.id;

        ctx.save();
        ctx.translate(sp.x, sp.y + bob);

        const colors = { speed: "#00ccff", rapid: "#ff4488", health: "#44ff88" };
        const color = colors[pu.type] || "#ffd700";

        // Sparkle particles
        if (Math.random() < 0.15) {
            spawnSparkle(pu.x + (Math.random() - 0.5) * 20, pu.y + (Math.random() - 0.5) * 20, color);
        }

        // Glow ring
        ctx.shadowColor = color;
        ctx.shadowBlur = 20;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.3 + Math.sin(t * 4) * 0.15;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
        ctx.stroke();

        // Spinning outer ring
        ctx.globalAlpha = 0.2;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.3, spin, spin + Math.PI * 1.2);
        ctx.stroke();

        // Main circle
        ctx.globalAlpha = 1;
        const puGrad = ctx.createRadialGradient(0, -r * 0.3, 0, 0, 0, r);
        puGrad.addColorStop(0, "#fff");
        puGrad.addColorStop(0.4, color);
        puGrad.addColorStop(1, color);
        ctx.fillStyle = puGrad;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();

        // Icon
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${13 * scaleX}px Orbitron`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const icons = { speed: "S", rapid: "R", health: "+" };
        ctx.fillText(icons[pu.type] || "?", 0, 0);

        ctx.shadowBlur = 0;
        ctx.restore();
    }
}

// ============================================
// RENDERING — Player (3D-like with shadows, glow, bounce)
// ============================================
function drawPlayer(index) {
    const isMe = index === myIndex;
    const px = isMe ? localX : players[index].x;
    const py = isMe ? localY : players[index].y;
    const p = players[index];

    if (!p.alive) return;

    const sp = arenaToScreen(px, py);
    const r = CFG.PLAYER_RADIUS * scaleX;
    const t = Date.now() / 1000;

    // Check if moving
    const isMoving = isMe ? (Math.abs(localVx) > 1 || Math.abs(localVy) > 1) : false;
    if (isMoving) moveTime += 0.05;

    // 1) Drop shadow on ground
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.beginPath();
    ctx.ellipse(sp.x, sp.y + r * 0.8, r * 1.0, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // 2) Colored glow ring on ground
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

    // Hit flash
    if (hitFlash[index] > 0) {
        ctx.globalAlpha = 0.5 + Math.sin(hitFlash[index] * 30) * 0.5;
    }

    // Bounce animation when moving
    const bounceY = isMoving ? Math.sin(moveTime * 8) * 3 * scaleY : 0;
    const bounceScale = isMoving ? 1 + Math.sin(moveTime * 8) * 0.04 : 1;

    // Idle bob
    const bob = Math.sin(t * 2.5 + index * Math.PI) * 2 * scaleY;
    ctx.translate(0, bob + bounceY);
    ctx.scale(bounceScale, bounceScale);

    // Determine facing direction from velocity
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

    // Use directional 3D sprite, fallback to legacy
    const dirSprite = sprites[`${base}_${playerDir[index]}`];
    const legacySprite = sprites[base];
    const activeSprite = dirSprite || legacySprite;

    if (activeSprite) {
        const size = r * 3;
        ctx.drawImage(activeSprite, -size / 2, -size / 2, size, size);
    } else {
        // Fallback: colorful circle with gradient
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

    // Powerup aura
    if (p.powerup) {
        const auraColors = { speed: "#00ccff", rapid: "#ff4488" };
        const auraColor = auraColors[p.powerup] || "#ffd700";
        ctx.strokeStyle = auraColor;
        ctx.lineWidth = 3;
        ctx.globalAlpha = 0.4 + Math.sin(t * 6) * 0.2;
        ctx.shadowColor = auraColor;
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.6, 0, Math.PI * 2);
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    ctx.restore();

    // Health bar above player (bigger, with gradient bg)
    ctx.globalAlpha = 1;
    const hpW = 50 * scaleX;
    const hpH = 6 * scaleY;
    const hpX = sp.x - hpW / 2;
    const hpY = sp.y - r * 1.5 - 10 * scaleY + bob;
    const hpFrac = Math.max(0, p.hp / CFG.PLAYER_HP);

    // Background
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    const hpBorderR = 3 * scaleX;
    ctx.beginPath();
    ctx.roundRect(hpX - 1, hpY - 1, hpW + 2, hpH + 2, hpBorderR);
    ctx.fill();

    // HP fill with gradient
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
        // Sheen
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.fillRect(hpX, hpY, hpW * hpFrac, hpH * 0.4);
    }
}

// ============================================
// RENDERING — Bullets (colorful with trails)
// ============================================
function drawBullets() {
    for (const b of bullets) {
        const sp = arenaToScreen(b.x, b.y);
        const r = CFG.BULLET_RADIUS * scaleX;
        const isMyBullet = b.owner === myIndex;

        // Trail particles
        if (Math.random() < 0.4) {
            const color = isMyBullet ? "#ff8800" : "#4488ff";
            spawnParticle(b.x + (Math.random() - 0.5) * 4, b.y + (Math.random() - 0.5) * 4,
                (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20,
                0.15 + Math.random() * 0.1, color, 1.5 + Math.random() * 1.5);
        }

        // Glow
        ctx.shadowColor = isMyBullet ? "#ff8800" : "#4488ff";
        ctx.shadowBlur = 12;

        // Bright bullet
        const bulGrad = ctx.createRadialGradient(sp.x, sp.y, 0, sp.x, sp.y, r * 1.5);
        if (isMyBullet) {
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
        ctx.arc(sp.x, sp.y, r * 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

// ============================================
// RENDERING — Dash trails (rainbow)
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

        // Rainbow colored ghost
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

function updateHUD() {
    const me = players[myIndex];
    const opp = players[1 - myIndex];

    const myHpPct = Math.max(0, me.hp / CFG.PLAYER_HP * 100);
    const oppHpPct = Math.max(0, opp.hp / CFG.PLAYER_HP * 100);
    document.getElementById("hp-bar-self").style.width = myHpPct + "%";
    document.getElementById("hp-bar-enemy").style.width = oppHpPct + "%";
    document.getElementById("hp-text-self").textContent = Math.max(0, Math.round(me.hp));
    document.getElementById("hp-text-enemy").textContent = Math.max(0, Math.round(opp.hp));

    const dashEl = document.getElementById("dash-indicator");
    if (me.dashCooldown > 0) {
        dashEl.textContent = `DASH ${(me.dashCooldown / 1000).toFixed(1)}s`;
        dashEl.classList.add("on-cooldown");
    } else {
        dashEl.textContent = "DASH READY";
        dashEl.classList.remove("on-cooldown");
    }

    const puEl = document.getElementById("powerup-indicator");
    if (me.powerup) {
        const labels = { speed: "SPEED BOOST", rapid: "RAPID FIRE" };
        puEl.textContent = labels[me.powerup] || me.powerup.toUpperCase();
        puEl.classList.remove("hidden");
    } else {
        puEl.classList.add("hidden");
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
        drawPowerups();
        drawDashTrails(dt);

        // Draw players (remote first, local on top)
        drawPlayer(1 - myIndex);
        drawPlayer(myIndex);

        drawBullets();
        drawParticles();
        drawAimLine();
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
