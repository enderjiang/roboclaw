'use strict';
/**
 * arm-cloud-relay  —  server.js
 * ==============================
 * Bridges the ESP32 robot arm (WebSocket client) with:
 *   - A REST API  (for your agent to call)
 *   - A browser control panel  (served from /frontend)
 *   - An optional Discord bot  (reads one channel for commands)
 *
 * Environment variables:
 *   PORT            HTTP port to listen on            (default: 3000)
 *   API_TOKEN       Secret token for REST API calls   (default: changeme)
 *   DISCORD_TOKEN   Discord bot token                 (optional)
 *   DISCORD_CHANNEL Discord channel ID to monitor     (optional)
 *
 * Deploy to Railway / Render / Fly.io — just set the env vars.
 */

const express   = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const http      = require('http');
const path      = require('path');

// ── Config ──────────────────────────────────────────────────────────
const PORT            = process.env.PORT            || 3000;
const API_TOKEN       = process.env.API_TOKEN       || 'changeme';
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL;

// ── Express app ──────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

const server = http.createServer(app);

// ── Shared state ─────────────────────────────────────────────────────
let esp32Ws  = null;
let armState = { type: 'state', angles: [90, 90, 90, 90, 90, 90] };

const browsers = new Set();  // connected browser WebSocket clients
const cmdLog   = [];         // recent command history (shown in UI)

function logCmd(source, cmd) {
    const entry = { ts: Date.now(), source, cmd };
    cmdLog.unshift(entry);
    if (cmdLog.length > 100) cmdLog.pop();
    broadcastBrowsers({ type: 'cmd_log', entries: cmdLog.slice(0, 40) });
}

function broadcastBrowsers(msg) {
    const txt = JSON.stringify(msg);
    for (const ws of browsers) {
        if (ws.readyState === WebSocket.OPEN) ws.send(txt);
    }
}

/** Send a command to the ESP32. Returns {ok, error?}. */
function relay(cmd, source) {
    if (!esp32Ws || esp32Ws.readyState !== WebSocket.OPEN) {
        console.warn(`[relay] ESP32 not connected — dropped command from ${source}`);
        return { ok: false, error: 'ESP32 not connected' };
    }
    esp32Ws.send(JSON.stringify(cmd));
    logCmd(source, cmd);
    return { ok: true };
}

// ── Sequence execution ────────────────────────────────────────────────
let seqActive = false;
let seqCancel = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runSequence(moves, loop, repeat) {
    seqActive = true;
    seqCancel = false;
    const iters = loop ? 1e9 : Math.max(1, repeat || 1);
    broadcastBrowsers({ type: 'sequence_start', total: moves.length, loop, repeat });
    try {
        for (let i = 0; i < iters && !seqCancel; i++) {
            for (let s = 0; s < moves.length && !seqCancel; s++) {
                const { waitMs = 2000, ...cmd } = moves[s];
                relay(cmd, 'sequence');
                broadcastBrowsers({ type: 'sequence_step', step: s + 1, total: moves.length,
                                    move: cmd, iteration: i + 1 });
                await sleep(waitMs);
            }
        }
    } finally {
        seqActive = false;
        broadcastBrowsers({ type: seqCancel ? 'sequence_stopped' : 'sequence_done' });
    }
}

// ── Auth middleware ──────────────────────────────────────────────────
function auth(req, res, next) {
    const tok = req.headers['x-api-token'] || req.query.token;
    if (tok !== API_TOKEN) return res.status(401).json({ error: 'Invalid or missing API token' });
    next();
}

// ── REST API ─────────────────────────────────────────────────────────

/**
 * POST /api/ik_move
 * Body: { x, y, z, pitch }
 * Sends an IK move command. ESP32 calculates servo angles.
 */
app.post('/api/ik_move', auth, (req, res) => {
    const { x = 150, y = 0, z = 100, pitch = 0 } = req.body;
    const r = relay({ type: 'ik_move', x, y, z, pitch }, 'api');
    res.status(r.ok ? 200 : 503).json(r.ok ? { status: 'sent', x, y, z, pitch } : r);
});

/**
 * POST /api/gripper
 * Body: { angle }   0 = fully open, 180 = fully closed
 */
app.post('/api/gripper', auth, (req, res) => {
    const { angle = 0 } = req.body;
    const r = relay({ type: 'move', channel: 5, angle }, 'api');
    res.status(r.ok ? 200 : 503).json(r.ok ? { status: 'sent', angle } : r);
});

/**
 * POST /api/home
 * Moves all joints to 90°.
 */
app.post('/api/home', auth, (req, res) => {
    const r = relay({ type: 'move_all', angles: [90, 90, 90, 90, 90, 90] }, 'api');
    res.status(r.ok ? 200 : 503).json(r.ok ? { status: 'sent' } : r);
});

/**
 * POST /api/servo
 * Body: { channel, angle }   Direct servo override (0–5, 0–180°)
 */
app.post('/api/servo', auth, (req, res) => {
    const { channel, angle } = req.body;
    if (channel == null || angle == null)
        return res.status(400).json({ error: 'channel and angle are required' });
    const r = relay({ type: 'move', channel, angle }, 'api');
    res.status(r.ok ? 200 : 503).json(r.ok ? { status: 'sent', channel, angle } : r);
});

/**
 * POST /api/command
 * Body: raw WebSocket JSON command — for advanced use.
 * Supported types: ik_move, move, move_all, get_state
 */
app.post('/api/command', auth, (req, res) => {
    const r = relay(req.body, 'api');
    res.status(r.ok ? 200 : 503).json(r.ok ? { status: 'sent' } : r);
});

/**
 * POST /api/sequence
 * Body: { moves: [{type, x, y, z, pitch, waitMs}, ...], loop, repeat }
 * Executes a series of moves with timing. Optional loop/repeat.
 */
app.post('/api/sequence', auth, (req, res) => {
    const { moves, loop = false, repeat = 1 } = req.body;
    if (!Array.isArray(moves) || !moves.length)
        return res.status(400).json({ error: 'moves[] array required' });
    if (seqActive) seqCancel = true;
    res.json({ status: 'started', count: moves.length, loop, repeat });
    setTimeout(() => runSequence(moves, loop, repeat), seqActive ? 200 : 0);
});

/**
 * POST /api/sequence/stop
 * Cancels any running sequence immediately.
 */
app.post('/api/sequence/stop', auth, (req, res) => {
    seqCancel = true;
    res.json({ status: 'stopping' });
});

/**
 * POST /api/message
 * Body: { role: 'assistant'|'system', text: '...' }
 * Pushes a chat message to the browser's Agent page.
 */
app.post('/api/message', auth, (req, res) => {
    const { role = 'assistant', text = '' } = req.body;
    broadcastBrowsers({ type: 'chat_message', role, text, ts: Date.now() });
    res.json({ status: 'sent' });
});

/**
 * GET /api/state
 * Returns current arm state (no auth required).
 */
app.get('/api/state', (req, res) => {
    const a = armState.angles || [90, 90, 90, 90, 90, 90];
    res.json({
        esp32Connected: !!(esp32Ws && esp32Ws.readyState === WebSocket.OPEN),
        angles: a,
        joints: {
            base:     a[0],
            shoulder: a[1],
            elbow:    a[2],
            wrist:    a[3],
            wrist2:   a[4],
            gripper:  a[5]
        }
    });
});

// ── WebSocket server ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
    const url = (req.url || '').split('?')[0];

    // ── ESP32 connection ──
    if (url === '/ws/esp32') {
        esp32Ws = ws;
        console.log('[ESP32] connected');
        broadcastBrowsers({ type: 'esp32_status', connected: true });
        ws.send(JSON.stringify({ type: 'get_state' }));

        ws.on('message', raw => {
            try {
                const msg = JSON.parse(raw.toString());
                if (msg.type === 'state') {
                    armState = msg;
                    broadcastBrowsers(msg);
                }
            } catch {}
        });

        ws.on('close', () => {
            if (esp32Ws === ws) esp32Ws = null;
            console.log('[ESP32] disconnected');
            broadcastBrowsers({ type: 'esp32_status', connected: false });
        });

        // Keepalive ping every 25s to prevent cloud proxy timeouts
        const ping = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
            else clearInterval(ping);
        }, 25000);

    } else {
        // ── Browser connection ──
        browsers.add(ws);

        ws.send(JSON.stringify(armState));
        ws.send(JSON.stringify({
            type: 'esp32_status',
            connected: !!(esp32Ws && esp32Ws.readyState === WebSocket.OPEN)
        }));
        ws.send(JSON.stringify({ type: 'cmd_log', entries: cmdLog.slice(0, 40) }));

        ws.on('message', raw => {
            try { relay(JSON.parse(raw.toString()), 'browser'); } catch {}
        });

        ws.on('close', () => browsers.delete(ws));
    }
});

// ── Discord bot (optional) ───────────────────────────────────────────
if (DISCORD_TOKEN && DISCORD_CHANNEL) {
    try {
        const { Client, GatewayIntentBits } = require('discord.js');
        const dc = new Client({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent
            ]
        });

        dc.once('ready', () => console.log(`[Discord] logged in as ${dc.user.tag}`));

        dc.on('messageCreate', msg => {
            if (msg.channel.id !== DISCORD_CHANNEL) return;
            if (msg.author.bot) return;

            const txt = msg.content.trim();

            if (txt.startsWith('{')) {
                try {
                    const cmd = JSON.parse(txt);
                    const r = relay(cmd, 'discord');
                    if (!r.ok) msg.reply(`❌ ${r.error}`);
                    else msg.react('✅');
                } catch { msg.reply('❌ Invalid JSON'); }
                return;
            }

            const low = txt.toLowerCase();
            if (low.startsWith('!move')) {
                const p = low.split(/\s+/);
                const x = parseFloat(p[1]) || 150;
                const y = parseFloat(p[2]) || 0;
                const z = parseFloat(p[3]) || 100;
                const pitch = parseFloat(p[4]) || 0;
                const r = relay({ type: 'ik_move', x, y, z, pitch }, 'discord');
                if (r.ok) msg.react('✅'); else msg.reply(`❌ ${r.error}`);
            } else if (low === '!home') {
                const r = relay({ type: 'move_all', angles: [90,90,90,90,90,90] }, 'discord');
                if (r.ok) msg.react('🏠'); else msg.reply(`❌ ${r.error}`);
            } else if (low === '!open') {
                const r = relay({ type: 'move', channel: 5, angle: 0 }, 'discord');
                if (r.ok) msg.react('✅'); else msg.reply(`❌ ${r.error}`);
            } else if (low === '!close') {
                const r = relay({ type: 'move', channel: 5, angle: 180 }, 'discord');
                if (r.ok) msg.react('✅'); else msg.reply(`❌ ${r.error}`);
            } else if (low === '!state') {
                const a = armState.angles || [];
                msg.reply(
                    `**Arm state**\n` +
                    `Base: ${a[0]}° | Shoulder: ${a[1]}° | Elbow: ${a[2]}°\n` +
                    `Wrist: ${a[3]}° | Wrist2: ${a[4]}° | Gripper: ${a[5]}°\n` +
                    `ESP32: ${esp32Ws ? '🟢 online' : '🔴 offline'}`
                );
            }
        });

        dc.login(DISCORD_TOKEN).catch(e => console.error('[Discord] login failed:', e.message));
    } catch (e) {
        console.warn('[Discord] discord.js not installed. Run: npm install discord.js');
    }
} else {
    console.log('[Discord] disabled (set DISCORD_TOKEN + DISCORD_CHANNEL env vars to enable)');
}

// ── Start ────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\nArm relay server running on port ${PORT}`);
    console.log(`Web panel : http://localhost:${PORT}`);
    console.log(`API token : ${API_TOKEN}`);
    console.log(`\nESP32 WebSocket : ws://localhost:${PORT}/ws/esp32`);
    console.log(`Browser WebSocket: ws://localhost:${PORT}/ws/browser\n`);
});
