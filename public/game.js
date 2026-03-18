// ============================================
// K vs K — Game Client
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

// Sprites
const sprites = { k1: null, k2: null };
let spritesLoaded = 0;

// Particles
const particlePool = [];
const activeParticles = [];

// Animation state
let hitFlash = [0, 0]; // flash timer per player
let dashTrail = [];     // {x, y, alpha, index}

// Aiming
let aimAngle = 0;
let mouseX = 0, mouseY = 0;

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
        // Pillarbox
        scaleY = H / CFG.ARENA_H;
        scaleX = scaleY;
        offsetX = (W - CFG.ARENA_W * scaleX) / 2;
        offsetY = 0;
    } else {
        // Letterbox
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
    const names = ["k1", "k2"];
    names.forEach(name => {
        const img = new Image();
        img.onload = () => {
            sprites[name] = img;
            spritesLoaded++;
        };
        img.src = `/assets/${name}.png`;
    });
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
    for (let i = 0; i < (count || 12); i++) {
        const angle = Math.random() * Math.PI * 2;
        const spd = 30 + Math.random() * 80;
        spawnParticle(x, y, Math.cos(angle) * spd, Math.sin(angle) * spd,
            0.4 + Math.random() * 0.3, color, 2 + Math.random() * 3);
    }
}

function updateParticles(dt) {
    for (let i = activeParticles.length - 1; i >= 0; i--) {
        const p = activeParticles[i];
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vx *= 0.95;
        p.vy *= 0.95;
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
        localX = players[myIndex].x;
        localY = players[myIndex].y;
        localVx = 0;
        localVy = 0;
        prevState = null;
        currState = null;

        gameState = "playing";
        showScreen(null);
        document.getElementById("hud").classList.remove("hidden");
        if (isMobile) document.getElementById("mobile-controls").classList.remove("hidden");

        notify("FIGHT!", "big");
        resize();
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

            // For remote player: update position for interpolation
            if (i !== myIndex) {
                players[i].targetX = sp.x;
                players[i].targetY = sp.y;
                if (players[i].x === undefined || players[i].x === 0) {
                    players[i].x = sp.x;
                    players[i].y = sp.y;
                }
            } else {
                // Reconcile local player with server
                const dx = sp.x - localX;
                const dy = sp.y - localY;
                const drift = Math.hypot(dx, dy);
                if (drift > 30) {
                    // Snap if too far
                    localX = sp.x;
                    localY = sp.y;
                } else if (drift > 2) {
                    // Smooth correction
                    localX = lerp(localX, sp.x, 0.15);
                    localY = lerp(localY, sp.y, 0.15);
                }
            }
        }

        // Update bullets from server
        bullets = state.bullets;
    });

    socket.on("player_hit", (data) => {
        SFX.hit();
        hitFlash[data.target] = 0.3;
        spawnExplosion(players[data.target].x, players[data.target].y,
            data.target === myIndex ? "#ff0044" : "#ff8844", 8);
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
        // Add dash trail
        for (let i = 0; i < 5; i++) {
            dashTrail.push({
                x: players[data.player].x,
                y: players[data.player].y,
                alpha: 0.6 - i * 0.1,
                index: data.player,
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

        if (isWinner) SFX.win(); else SFX.lose();

        const titleEl = document.getElementById("result-title");
        titleEl.textContent = isWinner ? "YOU WIN!" : "YOU LOSE";
        titleEl.className = "screen-title result-title " + (isWinner ? "win" : "lose");

        document.getElementById("result-my-hp").textContent = Math.max(0, Math.round(players[myIndex].hp));
        document.getElementById("result-opp-hp").textContent = Math.max(0, Math.round(players[1 - myIndex].hp));
        document.getElementById("restart-status").classList.add("hidden");

        document.getElementById("hud").classList.add("hidden");
        document.getElementById("mobile-controls").classList.add("hidden");
        showScreen("gameover-screen");
    });

    socket.on("opponent_disconnected", () => {
        if (gameState === "playing") {
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
    // Prevent scrolling
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
        e.preventDefault();
    }
    // Dash on shift
    if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
        if (gameState === "playing" && socket) {
            socket.emit("player_ability");
        }
    }
    // Init audio on first interaction
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
    // Auto-fire for mobile: shoot toward opponent
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
    // Aim toward opponent
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

    // Normalize
    const mag = Math.hypot(dx, dy);
    if (mag > 1) { dx /= mag; dy /= mag; }

    socket.emit("player_input", { dx, dy, seq: ++inputSeq });

    // Local prediction
    let speed = CFG.PLAYER_SPEED;
    if (players[myIndex].powerup === "speed") speed *= 1.5;
    localVx = dx * speed;
    localVy = dy * speed;
}

// ============================================
// RENDERING
// ============================================
function drawArena() {
    // Background
    ctx.fillStyle = "#0a0a1a";
    ctx.fillRect(0, 0, W, H);

    // Arena floor
    const tl = arenaToScreen(0, 0);
    const br = arenaToScreen(CFG.ARENA_W, CFG.ARENA_H);
    const aw = br.x - tl.x;
    const ah = br.y - tl.y;

    // Grid lines
    ctx.strokeStyle = "rgba(255, 100, 34, 0.06)";
    ctx.lineWidth = 1;
    const gridSize = 50;
    for (let x = 0; x <= CFG.ARENA_W; x += gridSize) {
        const sp = arenaToScreen(x, 0);
        const ep = arenaToScreen(x, CFG.ARENA_H);
        ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(ep.x, ep.y); ctx.stroke();
    }
    for (let y = 0; y <= CFG.ARENA_H; y += gridSize) {
        const sp = arenaToScreen(0, y);
        const ep = arenaToScreen(CFG.ARENA_W, y);
        ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(ep.x, ep.y); ctx.stroke();
    }

    // Arena border
    ctx.strokeStyle = "rgba(255, 100, 34, 0.3)";
    ctx.lineWidth = 2;
    ctx.strokeRect(tl.x, tl.y, aw, ah);

    // Corner accents
    const cornerSize = 20 * scaleX;
    ctx.strokeStyle = "#ff6622";
    ctx.lineWidth = 2;
    // Top-left
    ctx.beginPath(); ctx.moveTo(tl.x, tl.y + cornerSize); ctx.lineTo(tl.x, tl.y); ctx.lineTo(tl.x + cornerSize, tl.y); ctx.stroke();
    // Top-right
    ctx.beginPath(); ctx.moveTo(br.x - cornerSize, tl.y); ctx.lineTo(br.x, tl.y); ctx.lineTo(br.x, tl.y + cornerSize); ctx.stroke();
    // Bottom-left
    ctx.beginPath(); ctx.moveTo(tl.x, br.y - cornerSize); ctx.lineTo(tl.x, br.y); ctx.lineTo(tl.x + cornerSize, br.y); ctx.stroke();
    // Bottom-right
    ctx.beginPath(); ctx.moveTo(br.x - cornerSize, br.y); ctx.lineTo(br.x, br.y); ctx.lineTo(br.x, br.y - cornerSize); ctx.stroke();
}

function drawPowerups() {
    const t = Date.now() / 1000;
    for (const pu of powerups) {
        const sp = arenaToScreen(pu.x, pu.y);
        const r = CFG.POWERUP_RADIUS * scaleX;
        const bob = Math.sin(t * 3 + pu.id) * 3 * scaleY;

        ctx.save();
        ctx.translate(sp.x, sp.y + bob);

        // Glow
        const colors = { speed: "#00aaff", rapid: "#ff3366", health: "#00ff88" };
        const color = colors[pu.type] || "#ffd700";
        ctx.shadowColor = color;
        ctx.shadowBlur = 15;

        // Circle
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.3 + Math.sin(t * 4) * 0.1;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.3, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();

        // Icon
        ctx.fillStyle = "#fff";
        ctx.font = `bold ${12 * scaleX}px Orbitron`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const icons = { speed: "S", rapid: "R", health: "+" };
        ctx.fillText(icons[pu.type] || "?", 0, 0);

        ctx.shadowBlur = 0;
        ctx.restore();
    }
}

function drawPlayer(index) {
    const isMe = index === myIndex;
    const px = isMe ? localX : players[index].x;
    const py = isMe ? localY : players[index].y;
    const p = players[index];

    if (!p.alive) return;

    const sp = arenaToScreen(px, py);
    const r = CFG.PLAYER_RADIUS * scaleX;
    const t = Date.now() / 1000;

    ctx.save();
    ctx.translate(sp.x, sp.y);

    // Hit flash
    if (hitFlash[index] > 0) {
        ctx.globalAlpha = 0.5 + Math.sin(hitFlash[index] * 30) * 0.5;
    }

    // Idle bob
    const bob = Math.sin(t * 2.5 + index * Math.PI) * 2 * scaleY;
    ctx.translate(0, bob);

    // Sprite
    const spriteName = index === 0 ? "k1" : "k2";
    if (sprites[spriteName]) {
        const size = r * 2.5;
        ctx.drawImage(sprites[spriteName], -size / 2, -size / 2, size, size);
    } else {
        // Fallback circle
        ctx.fillStyle = index === 0 ? "#ff6622" : "#0088ff";
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
    }

    // Powerup aura
    if (p.powerup) {
        const auraColors = { speed: "#00aaff", rapid: "#ff3366" };
        ctx.strokeStyle = auraColors[p.powerup] || "#ffd700";
        ctx.lineWidth = 2;
        ctx.globalAlpha = 0.4 + Math.sin(t * 5) * 0.2;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.5, 0, Math.PI * 2);
        ctx.stroke();
    }

    ctx.restore();

    // Health bar above player
    ctx.globalAlpha = 1;
    const hpW = 40 * scaleX;
    const hpH = 4 * scaleY;
    const hpX = sp.x - hpW / 2;
    const hpY = sp.y - r - 12 * scaleY + bob;
    const hpFrac = Math.max(0, p.hp / CFG.PLAYER_HP);

    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.fillRect(hpX, hpY, hpW, hpH);
    ctx.fillStyle = isMe ? "#00ff88" : "#ff0044";
    ctx.fillRect(hpX, hpY, hpW * hpFrac, hpH);
}

function drawBullets() {
    for (const b of bullets) {
        const sp = arenaToScreen(b.x, b.y);
        const r = CFG.BULLET_RADIUS * scaleX;
        const isMyBullet = b.owner === myIndex;

        ctx.fillStyle = isMyBullet ? "#00ff88" : "#ff3366";
        ctx.shadowColor = isMyBullet ? "#00ff88" : "#ff3366";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
}

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
        ctx.globalAlpha = trail.alpha * 0.4;
        const spriteName = trail.index === 0 ? "k1" : "k2";
        if (sprites[spriteName]) {
            const size = r * 2.5;
            ctx.drawImage(sprites[spriteName], sp.x - size / 2, sp.y - size / 2, size, size);
        }
    }
    ctx.globalAlpha = 1;
}

function drawAimLine() {
    if (isMobile || gameState !== "playing") return;
    const sp = arenaToScreen(localX, localY);
    const lineLen = 50 * scaleX;

    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sp.x, sp.y);
    ctx.lineTo(sp.x + Math.cos(aimAngle) * lineLen, sp.y + Math.sin(aimAngle) * lineLen);
    ctx.stroke();
    ctx.setLineDash([]);
}

function updateHUD() {
    const me = players[myIndex];
    const opp = players[1 - myIndex];

    // HP bars
    const myHpPct = Math.max(0, me.hp / CFG.PLAYER_HP * 100);
    const oppHpPct = Math.max(0, opp.hp / CFG.PLAYER_HP * 100);
    document.getElementById("hp-bar-self").style.width = myHpPct + "%";
    document.getElementById("hp-bar-enemy").style.width = oppHpPct + "%";
    document.getElementById("hp-text-self").textContent = Math.max(0, Math.round(me.hp));
    document.getElementById("hp-text-enemy").textContent = Math.max(0, Math.round(opp.hp));

    // Dash indicator
    const dashEl = document.getElementById("dash-indicator");
    if (me.dashCooldown > 0) {
        dashEl.textContent = `DASH ${(me.dashCooldown / 1000).toFixed(1)}s`;
        dashEl.classList.add("on-cooldown");
    } else {
        dashEl.textContent = "DASH READY";
        dashEl.classList.remove("on-cooldown");
    }

    // Powerup indicator
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

    // Cap at 30fps
    const elapsed = timestamp - lastFrame;
    if (elapsed < FRAME_TIME * 0.9) return;
    lastFrame = timestamp;
    const dt = Math.min(elapsed / 1000, 0.1); // seconds, capped

    if (gameState === "playing") {
        // Send input to server
        sendInput();

        // Local prediction for my player
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

        // Update particles
        updateParticles(dt);

        // Update aim angle
        updateAimAngle();

        // HUD
        updateHUD();
    }

    // Render
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
    if (socket && socket.connected) {
        socket.emit("restart_request");
        const rs = document.getElementById("restart-status");
        rs.textContent = "Waiting for opponent...";
        rs.classList.remove("hidden");
    }
});

document.getElementById("btn-menu").addEventListener("click", () => {
    SFX.click();
    if (socket) { socket.disconnect(); socket = null; }
    showScreen("title-screen");
    gameState = "title";
    document.getElementById("hud").classList.add("hidden");
    document.getElementById("mobile-controls").classList.add("hidden");
});

// Enter key joins room
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
    showScreen("title-screen");
    requestAnimationFrame(gameLoop);
}

window.addEventListener("resize", () => {
    resize();
    detectMobile();
});

init();

})();
