const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const crypto = require('crypto');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 8080;

// ============ WEBSOCKET SERVER ============
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store all connected clients
const wsClients = new Set();

wss.on('connection', (ws) => {
    wsClients.add(ws);
    console.log('[WS] Client connected. Total clients:', wsClients.size);
    
    ws.on('close', () => {
        wsClients.delete(ws);
        console.log('[WS] Client disconnected. Total clients:', wsClients.size);
    });
    
    ws.on('error', (err) => {
        console.error('[WS] Client error:', err.message);
        wsClients.delete(ws);
    });
});

// Broadcast message to all WebSocket clients
function broadcastToClients(message) {
    if (wsClients.size === 0) return;
    
    const payload = JSON.stringify(message);
    for (const client of wsClients) {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(payload);
            } catch (e) {
                console.error('[WS] Send error:', e.message);
            }
        }
    }
}

// Database
const { initializeDatabase, testConnection, closePool, query } = require('./database/connection');
const Account = require('./database/models/Account');
const ScheduledPost = require('./database/models/ScheduledPost');
const Group = require('./database/models/Group');
const GroupBlacklist = require('./database/models/GroupBlacklist');
const Template = require('./database/models/Template');
const PostHistory = require('./database/models/PostHistory');

// Core functions
const { launchBrowserWithCookies, postToGroup, joinGroupOnPage, delay } = require('./fbPosterCore');
const { scrapeJoinedGroups, searchGroupsByKeyword, joinGroup } = require('./fbScraper');
const { openFacebookForLogin, extractProfileFromCookies } = require('./fbLogin');
const puppeteer = require('puppeteer');

// Group scanner
const { scanJoinedGroups, searchAndJoinGroups, searchGroupsFiltered, joinGroupFromSearchPage } = require('./groupScanner');

// Export/Import helpers
const fs = require('fs');
const { Parser } = require('json2csv');
const multer = require('multer');

// Multer setup for file uploads
const uploadDir = path.join(__dirname, 'web-dashboard', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedExt = /jpeg|jpg|png|gif|webp|bmp|tiff|svg|mp4|mov|avi|mkv|flv|wmv|pdf|txt|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z/;
        const allowedMime = /image\/|video\/|application\/pdf|text\/|application\/msword|application\/vnd\.|application\/zip|application\/x-rar-compressed|application\/x-7z-compressed/;

        const ext = allowedExt.test(path.extname(file.originalname).toLowerCase().replace('.', ''));
        const mime = allowedMime.test(file.mimetype);

        if (ext || mime) {
            cb(null, true);
        } else {
            cb(new Error(`File type not allowed: ${file.originalname} (${file.mimetype})`), false);
        }
    }
});

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

// Test endpoint di VERY AWAL - sebelum apapun
app.get('/ping', (req, res) => {
    console.log('GET /ping called');
    res.json({ success: true, message: 'pong', timestamp: new Date().toISOString() });
});

// Middleware
// List all images in uploads folder
app.get('/api/uploads-images', (req, res) => {
    const uploadsDir = path.join(__dirname, 'web-dashboard', 'uploads');
    try {
        const files = fs.readdirSync(uploadsDir).filter(f => {
            const ext = f.toLowerCase().split('.').pop();
            return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
        });
        const images = files.map(f => ({
            name: f,
            path: '/uploads/' + f,
            url: '/uploads/' + f
        }));
        res.json({ success: true, images });
    } catch (err) {
        res.json({ success: true, images: [] });
    }
});
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Anti-cache untuk halaman HTML — browser selalu memuat versi terbaru
app.use((req, res, next) => {
    if (req.path.endsWith('.html') || req.path === '/') {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});

app.use(express.static(path.join(__dirname, 'public-v2')));
app.use('/uploads', express.static(path.join(__dirname, 'web-dashboard', 'uploads')));


// Global state
let isPosting = false;
let isAutoJoining = false;
let currentJob = null;

// ============ POSTING CONTROL (Pause / Resume / Stop) ============
// State kontrol untuk job posting yang sedang berjalan via /api/post-now
const postControl = {
    active: false,        // apakah ada job yang sedang berjalan
    paused: false,        // apakah job sedang di-pause (manual oleh pengguna)
    stopped: false,       // apakah job dihentikan permanen
    autoPaused: false,    // apakah sedang auto-pause (spam / network timeout)
    autoPauseUntil: null, // ISO timestamp kapan auto-pause berakhir
    autoPauseReason: null,// alasan auto-pause terakhir
    resumeResolve: null,  // resolver untuk membangunkan loop yang sedang pause
    log: () => {}         // callback log (di-set saat job mulai)
};

function resetPostControl() {
    postControl.active = false;
    postControl.paused = false;
    postControl.stopped = false;
    postControl.autoPaused = false;
    postControl.autoPauseUntil = null;
    postControl.autoPauseReason = null;
    if (postControl.resumeResolve) {
        postControl.resumeResolve();
        postControl.resumeResolve = null;
    }
}

// ============ AUTO-PAUSE (Spam / Network Timeout) ============
// Durasi jeda otomatis setiap kali terdeteksi spam / network timeout.
const AUTO_PAUSE_MS = 60 * 60 * 1000; // 1 jam (tetap)

// Cek apakah pesan error menandakan gangguan jaringan / composer gagal kirim.
function isNetworkTimeoutError(message) {
    if (!message) return false;
    const msg = String(message).toLowerCase();
    return (
        msg.includes('network request timed out') ||
        msg.includes('composerstorycreatemutation') ||
        msg.includes('net::err_') ||
        msg.includes('timeouterror') ||
        msg.includes('navigation timeout') ||
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('socket hang up') ||
        msg.includes('target closed') ||
        msg.includes('protocol error')
    );
}

// Delay yang bisa diinterupsi: memotong waktu tunggu saat pause/stop ditekan.
// Mengembalikan true jika dihentikan (stop), false jika selesai / resume biasa.
async function interruptibleDelay(ms, pollMs = 500) {
    let remaining = ms;

    while (remaining > 0) {
        if (postControl.stopped) return true;

        // Tunggu sampai resume jika sedang di-pause
        if (postControl.paused) {
            await new Promise(resolve => { postControl.resumeResolve = resolve; });
            continue;
        }

        const slice = Math.min(pollMs, remaining);
        await delay(slice);
        remaining -= slice;
    }

    return postControl.stopped;
}

// Blokir selama pause. Mengembalikan true jika dihentikan (stop).
async function waitWhilePaused() {
    while (postControl.paused && !postControl.stopped) {
        await new Promise(resolve => { postControl.resumeResolve = resolve; });
    }
    return postControl.stopped;
}

// ============ JOB BUFFER (untuk pulihkan progress setelah refresh) ============
// Menyimpan progress + log job posting yang sedang berjalan di memori server,
// supaya ketika halaman dashboard di-refresh, progress & log TIDAK hilang.
const activePostJob = {
    active: false,
    finished: false,
    startedAt: null,
    finishedAt: null,
    total: 0,
    current: 0,
    success: 0,
    pending: 0,
    failed: 0,
    logs: [],       // { message, type, timestamp }
    summary: null
};

function resetActivePostJob(totalGroups = 0) {
    activePostJob.active = true;
    activePostJob.finished = false;
    activePostJob.startedAt = new Date().toISOString();
    activePostJob.finishedAt = null;
    activePostJob.total = totalGroups;
    activePostJob.current = 0;
    activePostJob.success = 0;
    activePostJob.pending = 0;
    activePostJob.failed = 0;
    activePostJob.logs = [];
    activePostJob.summary = null;
}

// Scan tracking: scanId -> scan data
const activeScans = new Map();

// Auto-join tracking: joinId -> join data
const activeJoins = new Map();

// ============ GRUP BLACKLIST ============
// Grup yang tidak punya post box ("Post box tidak ditemukan di halaman utama")
// dianggap blacklist: dihapus dari Manajemen Grup + dicatat agar tidak masuk lagi
// saat scan berikutnya.
async function blacklistGroup(groupId, accountId, groupName, reason, log) {
    const gid = String(groupId);
    try {
        await GroupBlacklist.add(gid, {
            accountId: accountId ?? null,
            groupName: groupName || null,
            reason: reason || 'Post box tidak ditemukan di halaman utama'
        });

        let removedRows = 0;
        try {
            const deleted = await Group.deleteByGroupId(gid, accountId ?? null);
            if (deleted) removedRows++;
        } catch (e) {
            console.error('[blacklist] Gagal menghapus dari fb_groups:', e.message);
        }

        if (log) {
            log(`🚫 Grup ${gid} masuk BLACKLIST — dihapus dari Manajemen Grup.`, 'warning');
        }
        return { ok: true, removedRows };
    } catch (e) {
        if (log) log(`⚠️ Gagal mem-blacklist grup ${gid}: ${e.message}`, 'warning');
        return { ok: false, removedRows: 0, error: e.message };
    }
}

// ============ WEBSOCKET BROADCAST ============
function broadcastLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const timestampStr = new Date().toLocaleTimeString('en-GB', { hour12: false });
    console.log(`[${timestampStr}] ${message}`);

    // Simpan ke buffer job supaya bisa dipulihkan setelah refresh halaman.
    if (activePostJob.active) {
        activePostJob.logs.push({ message, type, timestamp: timestampStr });
        // Batasi jumlah log agar memori tidak membengkak
        if (activePostJob.logs.length > 1000) {
            activePostJob.logs.splice(0, activePostJob.logs.length - 1000);
        }
    }

    // Send to all WebSocket clients
    broadcastToClients({
        message: message,
        type: type,
        timestamp: timestampStr
    });
}

// ============ API ROUTES ============

// File Upload
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            // Cek jika ada error dari multer (file type not allowed, etc)
            return res.status(400).json({ success: false, error: 'No file uploaded or file type not allowed' });
        }

        const filePath = `/uploads/${req.file.filename}`;
        res.json({
            success: true,
            filePath: filePath,
            filename: req.file.filename,
            originalName: req.file.originalname,
            size: req.file.size,
            mimetype: req.file.mimetype
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Multer error handler middleware
app.use((err, req, res, next) => {
    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, error: 'File size too large. Maximum 10MB allowed.' });
    }
    if (err.message && err.message.includes('File type not allowed')) {
        return res.status(400).json({ success: false, error: err.message });
    }
    next(err);
});

// Health check
app.get('/api/health', async (req, res) => {
    const dbOk = await testConnection();
    res.json({
        status: 'ok',
        database: dbOk ? 'connected' : 'disconnected',
        timestamp: new Date().toISOString()
    });
});

// ============ COOKIE VALIDATION ============

// ============ IMAGE FOLDER ============
app.get('/api/images', async (req, res) => {
    console.log("[DEBUG] /api/images route called");
    const imgFolder = path.join(__dirname, 'img');
    try {
        const files = fs.readdirSync(imgFolder).filter(f => {
            const ext = f.toLowerCase().split('.').pop();
            return ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(ext);
        });
        const images = files.map(f => ({
            name: f,
            path: '/img/' + f,
            url: '/img/' + f
        }));
        res.json({ success: true, images });
    } catch (err) {
        res.json({ success: true, images: [] });
    }
});

async function validateFacebookCookies(cookiesJson) {
    let browser, page;
    try {
        console.log('[validateFacebookCookies] Launching browser...');
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        page = await browser.newPage();

        // Set cookies
        if (typeof cookiesJson === 'string') {
            cookiesJson = JSON.parse(cookiesJson);
        }

        console.log('[validateFacebookCookies] Setting', cookiesJson.length, 'cookies...');
        await page.setCookie(...cookiesJson);

        // Navigate to Facebook
        console.log('[validateFacebookCookies] Navigating to Facebook...');
        await page.goto('https://facebook.com', { waitUntil: 'networkidle2', timeout: 30000 });

        // Check if logged in
        console.log('[validateFacebookCookies] Checking login status...');
        const isLoggedIn = await page.evaluate(() => {
            return document.body.innerText.includes('c_user') === false &&
                   (document.querySelector('[aria-label="Beranda"]') !== null ||
                    document.querySelector('[aria-label="Home"]') !== null ||
                    document.querySelector('[data-pagelet="LeftRail"]') !== null);
        });

        console.log('[validateFacebookCookies] isLoggedIn:', isLoggedIn);
        await browser.close();
        return { valid: isLoggedIn, error: null };

    } catch (error) {
        console.error('[validateFacebookCookies] Error:', error.message);
        if (browser) await browser.close();
        return { valid: false, error: error.message };
    }
}

app.post('/api/accounts/validate-cookies', async (req, res) => {
    try {
        const { cookies_json } = req.body;
        const result = await validateFacebookCookies(cookies_json);
        res.json({ success: true, ...result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SCRAPER API ============

// Scrape joined groups
app.post('/api/scrape-groups/:accountId', async (req, res) => {
    const { accountId } = req.params;

    res.json({ success: true, message: 'Scraping started' });

    (async () => {
        try {
            const account = await Account.getById(accountId);
            if (!account) {
                broadcastLog(`❌ Account ${accountId} not found`, 'error');
                return;
            }

            broadcastLog(`🔍 Scraping joined groups for ${account.name}...`, 'info');

            let cookies = typeof account.cookies_json === 'string'
                ? JSON.parse(account.cookies_json)
                : account.cookies_json;

            const groups = await scrapeJoinedGroups(cookies, (progress) => {
                broadcastLog(`${progress.status}: ${progress.message}`, 'info');
            });

            // Save groups to database
            let savedCount = 0;
            for (const group of groups) {
                try {
                    await Group.create({
                        facebook_account_id: accountId,
                        group_id: group.group_id,
                        group_name: group.group_name,
                        group_type: 'unknown',
                        is_joined: true,
                        status: 'active'
                    });
                    savedCount++;
                } catch (e) {
                    if (!e.message.includes('duplicate')) {
                        console.error('Error saving group:', e.message);
                    }
                }
            }

            broadcastLog(`✅ Scraping complete! Found ${groups.length} groups, saved ${savedCount} new`, 'success');

        } catch (error) {
            broadcastLog(`❌ Scraping failed: ${error.message}`, 'error');
        }
    })();
});

// Search groups by keyword
app.post('/api/search-groups/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const { keyword } = req.body;

    if (!keyword) {
        return res.status(400).json({ success: false, error: 'Keyword required' });
    }

    res.json({ success: true, message: 'Search started' });

    (async () => {
        try {
            const account = await Account.getById(accountId);
            if (!account) {
                broadcastLog(`❌ Account ${accountId} not found`, 'error');
                return;
            }

            broadcastLog(`🔍 Searching groups with keyword "${keyword}" for ${account.name}...`, 'info');

            let cookies = typeof account.cookies_json === 'string'
                ? JSON.parse(account.cookies_json)
                : account.cookies_json;

            const groups = await searchGroupsByKeyword(cookies, keyword, (progress) => {
                broadcastLog(`${progress.status}: ${progress.message}`, 'info');
            });

            broadcastLog(`✅ Search complete! Found ${groups.length} groups`, 'success');

        } catch (error) {
            broadcastLog(`❌ Search failed: ${error.message}`, 'error');
        }
    })();
});

// Join group
app.post('/api/join-group/:accountId', async (req, res) => {
    const { accountId } = req.params;
    const { group_id } = req.body;

    try {
        const account = await Account.getById(accountId);
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }

        let cookies = typeof account.cookies_json === 'string'
            ? JSON.parse(account.cookies_json)
            : account.cookies_json;

        const joined = await joinGroup(cookies, group_id);

        if (joined) {
            // Save to database
            try {
                await Group.create({
                    facebook_account_id: accountId,
                    group_id: group_id,
                    group_name: req.body.group_name || `Group ${group_id}`,
                    is_joined: true,
                    status: 'active'
                });
            } catch (e) {
                // Already exists, update status
            }
        }

        res.json({ success: true, joined });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ AUTO JOIN GROUPS API ============

// POST /api/auto-join-groups - Start auto-join with filters
app.post('/api/auto-join-groups', async (req, res) => {
    const {
        account_id,
        keyword,
        max_groups = 100,
        skip_joined = true,        // skip groups already joined
        min_members = 0,           // minimum member count filter
        nearby = false,            // filter "Di sekitar saya" (grup lokal)
        public_only = false,       // filter "Grup publik" (hanya grup publik)
        auto_answer = 'Setuju dengan aturan grup dan ingin bergabung untuk berdiskusi.',
        delay_seconds = 60,        // delay between joins
        use_variable_delay = true
    } = req.body;

    if (isAutoJoining) {
        return res.status(400).json({ success: false, error: 'Auto-join already in progress' });
    }

    if (!account_id || !keyword) {
        return res.status(400).json({ success: false, error: 'Account ID and keyword are required' });
    }

    const joinId = crypto.randomUUID();

    // Initialize join tracking entry
    activeJoins.set(joinId, {
        id: joinId,
        accountId: account_id,
        keyword,
        status: 'searching',
        phase: 'searching',
        foundGroups: 0,
        targetGroups: 0,
        joined: 0,
        alreadyJoined: 0,
        pending: 0,
        failed: 0,
        full: 0,
        totalMembers: 0,
        currentGroup: null,
        results: { success: [], alreadyJoined: [], pending: [], failed: [], full: [] },
        startedAt: new Date().toISOString(),
        completedAt: null,
        browser: null,
        abortController: new AbortController()
    });

    res.json({ success: true, joinId, message: 'Auto-join started' });

    // Set flag immediately to prevent concurrent auto-join
    isAutoJoining = true;

    // Run in background
    (async () => {
        let browser, page;
        const joinData = activeJoins.get(joinId);

        try {
            const account = await Account.getById(account_id);
            if (!account) throw new Error('Account not found');

            broadcastLog(`🚀 AUTO JOIN: Starting for account "${account.name}" — keyword: "${keyword}"`, 'info');
            broadcastLog(`📋 Filter: max ${max_groups} grup, prioritas: aktif + anggota terbanyak, skip joined: ${skip_joined ? 'ya' : 'tidak'}, min members: ${min_members}, di sekitar saya: ${nearby ? 'YA 📍' : 'tidak'}, grup publik: ${public_only ? 'YA 🌐' : 'tidak'}`, 'info');

            // Parse cookies
            let cookies = account.cookies_json;
            if (typeof cookies === 'string') {
                try { cookies = JSON.parse(cookies); } catch (e) { /* keep as-is */ }
            }

            // Launch browser with account cookies
            const launchResult = await launchBrowserWithCookies(null, { cookiesOverride: cookies });
            browser = launchResult.browser;
            page = launchResult.page;
            joinData.browser = browser;

            // ============ PHASE 1: SEARCH & COLLECT GROUPS ============
            broadcastLog(`🔍 Phase 1: Mencari grup dengan keyword "${keyword}"...`, 'info');

            // Kumpulkan secukupnya saja: target + buffer untuk filter (skip joined / min members)
            // Contoh: limit 3 → kumpulkan max 13, limit 500 → kumpulkan max 1000
            const collectTarget = Math.max(max_groups * 2, max_groups + 10);

            const searchResult = await searchGroupsFiltered(page, {
                keyword,
                maxResults: collectTarget,
                // FB memuat ~10 grup per scroll; beri kelonggaran 3x + 20 agar target besar tercapai
                maxScrolls: Math.ceil(collectTarget / 10) * 3 + 20,
                maxStagnantScrolls: 12,
                nearby: !!nearby,
                publicOnly: !!public_only,
                signal: joinData.abortController.signal,
                onProgress: (progress) => {
                    joinData.foundGroups = progress.found;
                    const skippedParts = [];
                    if (progress.skippedJoined > 0) skippedParts.push(`${progress.skippedJoined} sudah di-join`);
                    if (progress.skippedFull > 0) skippedParts.push(`${progress.skippedFull} grup penuh`);
                    if (skippedParts.length > 0) {
                        broadcastLog(`🔍 Searching... ${progress.found} grup ditemukan (scroll ${progress.scrollCount}) — dilewati: ${skippedParts.join(', ')} (tidak dihitung)`, 'info');
                    } else {
                        broadcastLog(`🔍 Searching... ${progress.found} grup ditemukan (scroll ${progress.scrollCount})`, 'info');
                    }
                }
            });

            if (joinData.abortController.signal.aborted) {
                joinData.status = 'cancelled';
                joinData.phase = 'cancelled';
                joinData.completedAt = new Date().toISOString();
                broadcastLog(`⚠️ AUTO JOIN ${joinId} dibatalkan saat pencarian`, 'warning');
                return;
            }

            let candidateGroups = searchResult.groups || [];
            broadcastLog(`📊 Ditemukan ${candidateGroups.length} grup dari pencarian`, 'info');

            // ============ PHASE 2: FILTER & SORT ============
            broadcastLog(`🧹 Phase 2: Memfilter & mengurutkan grup...`, 'info');

            // Filter: minimum members
            if (min_members > 0) {
                candidateGroups = candidateGroups.filter(g => (g.member_count_raw || 0) >= min_members);
                broadcastLog(`📊 Setelah filter min ${min_members} anggota: ${candidateGroups.length} grup`, 'info');
            }

            // Filter: skip groups already joined (from database)
            if (skip_joined) {
                const joinedGroups = await Group.getAll({ account_id });
                const joinedIds = new Set(joinedGroups.map(g => g.group_id));
                const beforeCount = candidateGroups.length;
                candidateGroups = candidateGroups.filter(g => !joinedIds.has(g.group_id));
                broadcastLog(`📊 Skip ${beforeCount - candidateGroups.length} grup yang sudah di-join (dari database)`, 'info');
            }

            // Sort: ANGGOTA TERBANYAK DAHULU — sesuai permintaan user,
            // join dimulai dari grup dengan anggota paling banyak.
            candidateGroups.sort((a, b) => (b.member_count_raw || 0) - (a.member_count_raw || 0));
            broadcastLog(`📊 Sort: anggota terbanyak dahulu`, 'info');

            // Limit to max_groups
            const targetGroups = candidateGroups.slice(0, max_groups);
            joinData.targetGroups = targetGroups.length;
            joinData.totalMembers = targetGroups.reduce((sum, g) => sum + (g.member_count_raw || 0), 0);
            broadcastLog(`🎯 Target: ${targetGroups.length} grup | TOTAL ANGGOTA: ${joinData.totalMembers.toLocaleString('id-ID')}`, 'info');
            joinData.status = 'joining';
            joinData.phase = 'joining';

            if (targetGroups.length === 0) {
                broadcastLog(`⚠️ Tidak ada grup yang memenuhi filter. Auto-join diakhiri.`, 'warning');
                joinData.status = 'completed';
                joinData.completedAt = new Date().toISOString();
                return;
            }

            broadcastLog(`🎯 Phase 3: Mulai join ${targetGroups.length} grup (delay ${delay_seconds}s antar grup)...`, 'info');

            // ============ PHASE 3: JOIN GROUPS ONE BY ONE ============
            // Anti-spam: kalau Facebook memblokir, tunggu cooldown lalu coba lagi.
            // Cooldown 15 menit (cukup aman, tidak terlalu lama), max 3x retry.
            const SPAM_COOLDOWN_MS = 15 * 60 * 1000;
            const SPAM_MAX_RETRIES = 3;
            let spamRetryCount = 0;
            let spamStopped = false;

            let i = 0;
            while (i < targetGroups.length) {
                if (joinData.abortController.signal.aborted) {
                    broadcastLog(`⚠️ AUTO JOIN ${joinId} dibatalkan oleh user`, 'warning');
                    joinData.status = 'cancelled';
                    joinData.phase = 'cancelled';
                    joinData.completedAt = new Date().toISOString();
                    return;
                }

                const group = targetGroups[i];
                const progress = `[${i + 1}/${targetGroups.length}]`;
                joinData.currentGroup = group.group_name || group.group_id;

                broadcastLog(`${progress} Klik Gabung: ${group.group_name || group.group_id} (${(group.member_count_raw || 0).toLocaleString('id-ID')} anggota)`, 'info');

                try {
                    // Join LANGSUNG dari halaman pencarian — klik tombol "Gabung" di kartu grup,
                    // tombol berubah jadi "Lihat" = sudah tergabung. Tidak perlu buka halaman grup.
                    const result = await joinGroupFromSearchPage(page, group.group_id, { autoAnswer: auto_answer });

                    if (result.success) {
                        if (result.alreadyJoined) {
                            joinData.alreadyJoined++;
                            joinData.results.alreadyJoined.push({ groupId: group.group_id, name: group.group_name });
                            broadcastLog(`${progress} ℹ️ Sudah di-join: ${group.group_name || group.group_id}`, 'info');
                        } else if (result.pendingApproval) {
                            joinData.pending++;
                            joinData.results.pending.push({ groupId: group.group_id, name: group.group_name });
                            const answerInfo = result.answeredQuestions ? ' (pertanyaan grup & aturan otomatis diisi ✍️)' : '';
                            broadcastLog(`${progress} ⏳ Request terkirim (pending approval): ${group.group_name || group.group_id}${answerInfo}`, 'warning');
                        } else {
                            joinData.joined++;
                            joinData.results.success.push({ groupId: group.group_id, name: group.group_name });
                            broadcastLog(`${progress} ✅ Berhasil join: ${group.group_name || group.group_id}`, 'success');
                        }

                        // Save to database
                        try {
                            await Group.save({
                                facebook_account_id: account_id,
                                group_id: group.group_id,
                                group_name: group.group_name || `Group ${group.group_id}`,
                                group_type: group.group_type || 'public',
                                member_count: group.member_count_raw || 0,
                                is_joined: true,
                                status: 'active'
                            });
                        } catch (e) {
                            console.error(`[auto-join] Failed to save group to DB: ${e.message}`);
                        }

                        i++; // lanjut ke grup berikutnya

                    } else if (result.spamDetected) {
                        spamRetryCount++;
                        if (spamRetryCount > SPAM_MAX_RETRIES) {
                            broadcastLog(`🛑 SPAM DETECTED ${spamRetryCount}x berturut-turut. Auto-join dihentikan demi keamanan akun.`, 'error');
                            spamStopped = true;
                            break;
                        }

                        const cooldownMin = Math.floor(SPAM_COOLDOWN_MS / 60000);
                        joinData.status = 'cooldown';
                        joinData.phase = 'cooldown';
                        broadcastLog(`🛑 SPAM DETECTED! (${result.error || 'Facebook membatasi aktivitas'}) — menunggu ${cooldownMin} menit sebelum mencoba lagi... (retry ${spamRetryCount}/${SPAM_MAX_RETRIES})`, 'error');
                        broadcastLog(`💡 Tips: kurangi jumlah grup & naikkan delay agar tidak terdeteksi spam`, 'warning');

                        for (let t = cooldownMin; t > 0; t--) {
                            if (joinData.abortController.signal.aborted) break;
                            await delay(60000);
                            if (t > 1) broadcastLog(`⏱️ Cooldown spam: ${t - 1} menit lagi...`, 'warning');
                        }

                        if (joinData.abortController.signal.aborted) {
                            broadcastLog(`⚠️ Auto-join dibatalkan saat cooldown spam`, 'warning');
                            joinData.status = 'cancelled';
                            joinData.phase = 'cancelled';
                            joinData.completedAt = new Date().toISOString();
                            return;
                        }

                        joinData.status = 'joining';
                        joinData.phase = 'joining';
                        broadcastLog(`🔄 Cooldown selesai, mencoba join lagi dari grup yang tertunda...`, 'info');
                        // Tidak increment i — coba ulang grup yang sama

                    } else if (result.groupNotFound) {
                        joinData.failed++;
                        joinData.results.failed.push({ groupId: group.group_id, name: group.group_name, error: result.error });
                        broadcastLog(`${progress} 🚫 SKIP (grup tidak ditemukan): ${group.group_name || group.group_id}`, 'warning');
                        i++;

                    } else if (result.groupFull) {
                        // Grup PENUH (batas anggota Facebook) — tidak bisa di-join,
                        // bukan error akun, jadi langsung skip tanpa retry
                        joinData.full++;
                        joinData.results.full.push({ groupId: group.group_id, name: group.group_name, error: result.error });
                        broadcastLog(`${progress} 🈵 SKIP (grup penuh): ${group.group_name || group.group_id} — ${result.error}`, 'warning');
                        i++;

                    } else {
                        joinData.failed++;
                        joinData.results.failed.push({ groupId: group.group_id, name: group.group_name, error: result.error });
                        broadcastLog(`${progress} ❌ Gagal join: ${group.group_name || group.group_id} — ${result.error}`, 'error');
                        i++;
                    }

                } catch (err) {
                    joinData.failed++;
                    joinData.results.failed.push({ groupId: group.group_id, name: group.group_name, error: err.message });
                    broadcastLog(`${progress} ❌ Error: ${group.group_name || group.group_id} — ${err.message}`, 'error');
                    i++;
                }

                // Variable delay antar grup (anti-detection)
                if (i < targetGroups.length && !joinData.abortController.signal.aborted) {
                    const baseDelay = delay_seconds * 1000;
                    const randomVariation = use_variable_delay ? Math.floor(Math.random() * 30000) : 0;
                    const totalDelay = baseDelay + randomVariation;

                    broadcastLog(`⏳ Waiting ${Math.floor(totalDelay / 1000)}s (base: ${delay_seconds}s + random: ${Math.floor(randomVariation / 1000)}s)...`, 'warning');
                    await delay(totalDelay);
                }
            }

            // ============ FINAL REPORT ============
            if (spamStopped) {
                joinData.status = 'failed';
                joinData.phase = 'failed';
                joinData.error = 'Dihentikan: Facebook mendeteksi spam setelah beberapa kali cooldown';
                broadcastLog(`🛑 AUTO JOIN DIHENTIKAN (spam) — hasil sementara: Join ${joinData.joined}, Pending ${joinData.pending}, Gagal ${joinData.failed}`, 'error');
            } else {
                joinData.status = 'completed';
                joinData.phase = 'completed';
            }
            joinData.completedAt = new Date().toISOString();
            joinData.currentGroup = null;

            broadcastLog(`📊 AUTO JOIN COMPLETE:`, 'info');
            broadcastLog(`   ✅ Berhasil join: ${joinData.joined}`, 'success');
            broadcastLog(`   ⏳ Pending approval: ${joinData.pending}`, 'warning');
            broadcastLog(`   ℹ️ Sudah di-join: ${joinData.alreadyJoined}`, 'info');
            broadcastLog(`   🈵 Grup penuh (skip): ${joinData.full}`, 'warning');
            broadcastLog(`   ❌ Gagal: ${joinData.failed}`, 'error');
            broadcastLog(`   👥 TOTAL ANGGOTA (target grup): ${joinData.totalMembers.toLocaleString('id-ID')}`, 'info');

        } catch (error) {
            broadcastLog(`❌ AUTO JOIN fatal error: ${error.message}`, 'error');
            joinData.status = 'failed';
            joinData.phase = 'failed';
            joinData.error = error.message;
            joinData.completedAt = new Date().toISOString();
        } finally {
            if (browser) {
                try { await browser.close(); } catch (e) { /* ignore */ }
            }
            isAutoJoining = false;
        }
    })();
});

// GET /api/auto-join-groups/:joinId - Get auto-join status/results
app.get('/api/auto-join-groups/:joinId', async (req, res) => {
    try {
        const { joinId } = req.params;
        const joinData = activeJoins.get(joinId);

        if (!joinData) {
            return res.status(404).json({ success: false, error: 'Auto-join session not found' });
        }

        res.json({
            success: true,
            status: joinData.status,
            phase: joinData.phase,
            keyword: joinData.keyword,
            foundGroups: joinData.foundGroups,
            targetGroups: joinData.targetGroups,
            joined: joinData.joined,
            alreadyJoined: joinData.alreadyJoined,
            pending: joinData.pending,
            failed: joinData.failed,
            full: joinData.full || 0,
            totalMembers: joinData.totalMembers || 0,
            currentGroup: joinData.currentGroup,
            results: joinData.results,
            startedAt: joinData.startedAt,
            completedAt: joinData.completedAt,
            error: joinData.error || null
        });

    } catch (error) {
        console.error('❌ Error getting auto-join status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/auto-join-groups/:joinId/cancel - Cancel an ongoing auto-join
app.post('/api/auto-join-groups/:joinId/cancel', async (req, res) => {
    try {
        const { joinId } = req.params;
        const joinData = activeJoins.get(joinId);

        if (!joinData) {
            return res.status(404).json({ success: false, error: 'Auto-join session not found' });
        }

        if (joinData.status !== 'searching' && joinData.status !== 'joining' && joinData.status !== 'cooldown') {
            return res.status(400).json({ success: false, error: `Auto-join is already ${joinData.status}` });
        }

        // Signal cancellation
        joinData.abortController.abort();
        joinData.status = 'cancelled';
        joinData.phase = 'cancelled';
        joinData.completedAt = new Date().toISOString();

        // Close browser if open
        if (joinData.browser) {
            try {
                await joinData.browser.close();
            } catch (e) {
                console.error('Error closing browser during cancellation:', e);
            }
        }

        broadcastLog(`⚠️ AUTO JOIN ${joinId} cancelled by user`, 'warning');

        res.json({ success: true, message: 'Auto-join cancelled' });

    } catch (error) {
        console.error('❌ Error cancelling auto-join:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ LOGIN API ============

app.post('/api/login-facebook', async (req, res) => {
    const { account_name, mode = 'quick' } = req.body;

    res.json({ success: true, message: 'Browser akan terbuka untuk login manual' });

    // Run in background
    (async () => {
        try {
            broadcastLog(`🔐 Membuka browser untuk login Facebook...`, 'info');
            broadcastLog(`Mode: ${mode === 'quick' ? 'Cepat' : 'Lengkap'}`, 'info');

            const loginResult = await openFacebookForLogin(mode, (progress) => {
                broadcastLog(`${progress.status}: ${progress.message}`, 'info');
            });

            // Save account to database
            const accountId = await Account.create({
                name: account_name || loginResult.name || 'Akun Facebook',
                facebook_id: loginResult.userId,
                email: loginResult.email || null,
                cookies_json: loginResult.cookies,
                status: 'active'
            });

            broadcastLog(`✅ Akun berhasil disimpan dengan ID: ${accountId}`, 'success');

        } catch (error) {
            broadcastLog(`❌ Login gagal: ${error.message}`, 'error');
        }
    })();
});

// ============ ACCOUNT API ============

app.get('/api/accounts', async (req, res) => {
    try {
        console.log('GET /api/accounts called');
        const accounts = await Account.getAll();
        console.log('Account.getAll returned:', accounts?.length || 0, 'accounts');
        res.json({ success: true, accounts });
    } catch (error) {
        console.error('Error in /api/accounts:', error);
        console.error('Error stack:', error?.stack);
        const errorMessage = error?.message || (typeof error === 'string' ? error : JSON.stringify(error)) || 'Unknown error';
        res.status(500).json({ success: false, error: errorMessage });
    }
});

// Import cookies - Add account via cookie import (MUST be before /:id routes)
app.post('/api/accounts/import-cookies', async (req, res) => {
    console.log('[import-cookies] Request received, body keys:', Object.keys(req.body || {}));
    try {
        const { account_name, cookies } = req.body;

        if (!cookies) {
            console.log('[import-cookies] Missing cookies in request body');
            return res.status(400).json({ success: false, error: 'Cookies JSON diperlukan' });
        }

        // Parse cookies jika string
        let parsedCookies = cookies;
        if (typeof cookies === 'string') {
            try {
                parsedCookies = JSON.parse(cookies);
            } catch (e) {
                console.log('[import-cookies] Invalid JSON format:', e.message);
                return res.status(400).json({ success: false, error: 'Format JSON tidak valid' });
            }
        }

        if (!Array.isArray(parsedCookies) || parsedCookies.length === 0) {
            console.log('[import-cookies] Cookies is not a valid array');
            return res.status(400).json({ success: false, error: 'Cookies harus berupa array' });
        }

        // Cek cookies penting
        const hasRequiredCookies = parsedCookies.some(c => c.name === 'c_user') &&
                                    parsedCookies.some(c => c.name === 'xs');
        if (!hasRequiredCookies) {
            console.log('[import-cookies] Missing required cookies (c_user or xs)');
            return res.status(400).json({ success: false, error: 'Cookies tidak lengkap, diperlukan c_user dan xs' });
        }

        console.log('[import-cookies] Required cookies found, proceeding with validation...');
        broadcastLog('🍪 Memvalidasi cookies...', 'info');

        // Validate cookies
        let validation;
        try {
            validation = await validateFacebookCookies(parsedCookies);
            console.log('[import-cookies] Validation result:', JSON.stringify(validation));
        } catch (validationError) {
            console.error('[import-cookies] validateFacebookCookies threw error:', validationError.message);
            broadcastLog(`❌ Validasi cookies gagal: ${validationError.message}`, 'error');
            return res.status(500).json({ success: false, error: 'Validasi cookies gagal: ' + validationError.message });
        }

        if (!validation.valid) {
            console.log('[import-cookies] Cookies validation failed:', validation.error);
            return res.status(400).json({ success: false, error: 'Cookies tidak valid atau expired: ' + (validation.error || '') });
        }

        broadcastLog('✅ Cookies valid!', 'success');
        broadcastLog('📥 Mengambil info profil...', 'info');

        // Extract profile info
        let profileInfo;
        try {
            profileInfo = await extractProfileFromCookies(parsedCookies);
            console.log('[import-cookies] Profile extracted:', JSON.stringify(profileInfo));
        } catch (profileError) {
            console.error('[import-cookies] extractProfileFromCookies threw error:', profileError.message);
            broadcastLog(`❌ Gagal mengambil profil: ${profileError.message}`, 'error');
            return res.status(500).json({ success: false, error: 'Gagal mengambil info profil: ' + profileError.message });
        }

        // Create account
        let accountId;
        try {
            accountId = await Account.create({
                name: account_name || profileInfo.name || 'Akun Facebook',
                facebook_id: profileInfo.facebook_id,
                email: profileInfo.email || null,
                cookies_json: parsedCookies,
                profile_picture: profileInfo.profile_picture || null,
                status: 'active'
            });
            console.log('[import-cookies] Account created with ID:', accountId);
        } catch (dbError) {
            console.error('[import-cookies] Account.create threw error:', dbError.message);
            broadcastLog(`❌ Gagal membuat akun: ${dbError.message}`, 'error');
            return res.status(500).json({ success: false, error: 'Gagal menyimpan akun ke database: ' + dbError.message });
        }

        broadcastLog(`✅ Akun berhasil dibuat: ${profileInfo.name}`, 'success');

        res.json({
            success: true,
            account: {
                id: accountId,
                name: profileInfo.name,
                facebook_id: profileInfo.facebook_id,
                profile_picture: profileInfo.profile_picture
            }
        });

    } catch (error) {
        console.error('[import-cookies] Unhandled error:', error);
        broadcastLog(`❌ Import cookies gagal: ${error.message}`, 'error');
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/accounts/:id', async (req, res) => {
    try {
        const account = await Account.getById(req.params.id);
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }

        const stats = await Account.getStats(req.params.id);
        res.json({ success: true, account: { ...account, stats } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/accounts', async (req, res) => {
    try {
        const { name, cookies_json, facebook_id, email, profile_picture } = req.body;

        // Validate required fields
        if (!name) {
            return res.status(400).json({ success: false, error: 'Name is required' });
        }

        const accountId = await Account.create({
            name: name || 'New Account',
            facebook_id: facebook_id || null,
            email: email || null,
            cookies_json: cookies_json || null,
            profile_picture: profile_picture || null
        });

        res.json({ success: true, accountId });
    } catch (error) {
        console.error('Error creating account:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/accounts/:id', async (req, res) => {
    try {
        const updated = await Account.update(req.params.id, req.body);
        res.json({ success: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Update cookies for existing account
app.put('/api/accounts/:id/update-cookies', async (req, res) => {
    try {
        const accountId = req.params.id;
        const { cookies } = req.body;
        
        if (!cookies || !Array.isArray(cookies)) {
            return res.status(400).json({ success: false, error: 'Invalid cookies format' });
        }
        
        // Update the account with new cookies
        const updated = await Account.update(accountId, {
            cookies_json: JSON.stringify(cookies)
        });
        
        if (updated) {
            res.json({ success: true, message: 'Cookies updated successfully' });
        } else {
            res.status(404).json({ success: false, error: 'Account not found' });
        }
    } catch (error) {
        console.error('Error updating cookies:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/accounts/:id', async (req, res) => {
    try {
        const deleted = await Account.delete(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SCHEDULED POSTS API ============

app.get('/api/scheduled-posts', async (req, res) => {
    try {
        console.log('GET /api/scheduled-posts called with query:', req.query);
        const posts = await ScheduledPost.getAll(req.query);
        console.log('ScheduledPost.getAll returned:', posts?.length || 0, 'posts');
        res.json({ success: true, posts });
    } catch (error) {
        console.error('Error in /api/scheduled-posts:', error);
        console.error('Error type:', typeof error);
        console.error('Error is null?', error === null);
        console.error('Error is undefined?', error === undefined);
        const errorMessage = error?.message || String(error) || 'Unknown error';
        console.error('Computed error message:', errorMessage);
        res.status(500).json({ success: false, error: errorMessage });
    }
});

app.post('/api/scheduled-posts', async (req, res) => {
    try {
        const postId = await ScheduledPost.create(req.body);
        res.json({ success: true, postId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/scheduled-posts/:id', async (req, res) => {
    try {
        const updated = await ScheduledPost.update(req.params.id, req.body);
        res.json({ success: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/scheduled-posts/:id', async (req, res) => {
    try {
        const deleted = await ScheduledPost.delete(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GROUPS API ============

app.get('/api/groups', async (req, res) => {
    try {
        console.log('Groups API called with filters:', req.query);
        const groups = await Group.getAll(req.query);
        console.log(`Found ${groups.length} groups`);
        res.json({ success: true, groups });
    } catch (error) {
        console.error('Error fetching groups:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/groups/posted-ids?account_id=X — group_id yang sudah pernah dipost (dari post_history)
app.get('/api/groups/posted-ids', async (req, res) => {
    try {
        const { account_id } = req.query;
        if (!account_id) return res.status(400).json({ success: false, error: 'account_id required' });
        // Hanya status sukses murni. 'group_disabled' BUKAN sukses (grup tak bisa diposting),
        // jadi jangan dimasukkan ke daftar "sudah dipost".
        const rows = await query(
            `SELECT DISTINCT CAST(group_id AS TEXT) as group_id FROM post_history WHERE CAST(facebook_account_id AS TEXT) = CAST(? AS TEXT) AND status IN ('success','pending_approval')`,
            [account_id]
        );
        const ids = rows.map(r => r.group_id);
        res.json({ success: true, posted_ids: ids });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/groups/:accountId/stats', async (req, res) => {
    try {
        const stats = await Group.getStats(req.params.accountId);
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/groups', async (req, res) => {
    try {
        const groupId = await Group.create(req.body);
        res.json({ success: true, groupId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/groups/:id', async (req, res) => {
    try {
        const deleted = await Group.delete(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GROUP BLACKLIST API ============

// Daftar grup blacklist (yang tidak punya post box / bermasalah permanen)
app.get('/api/groups/blacklist', async (req, res) => {
    try {
        const accountId = req.query.account_id ?? null;
        const rows = await GroupBlacklist.getAll(
            accountId ? { account_id: accountId } : {}
        );
        res.json({ success: true, blacklist: rows, total: rows.length });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Hapus grup dari blacklist (agar bisa discan/diposting lagi)
app.delete('/api/groups/blacklist/:groupId', async (req, res) => {
    try {
        const accountId = req.query.account_id ?? null;
        const removed = await GroupBlacklist.remove(req.params.groupId, accountId);
        res.json({ success: removed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Kosongkan seluruh blacklist
app.delete('/api/groups/blacklist', async (req, res) => {
    try {
        const removed = await GroupBlacklist.removeAll();
        res.json({ success: removed });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GROUP SCANNING API ============

// POST /api/groups/scan - Start a group scanning operation
app.post('/api/groups/scan', async (req, res) => {
    try {
        const { accountId, options = {} } = req.body;

        if (!accountId) {
            return res.status(400).json({ success: false, error: 'Account ID is required' });
        }

        const account = await Account.getById(accountId);
        if (!account) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }

        const scanId = crypto.randomUUID();
        // If autoScrollAll is enabled, use higher maxScrolls and lower stagnation threshold
        const autoScrollAll = options.autoScrollAll !== false;
        // FIX: For users with 2000+ groups, need much higher limits
        // Default: 2000 scrolls for auto-scroll all, or use custom value from UI
        const effectiveMaxScrolls = options.maxScrolls || (autoScrollAll ? 2000 : 30);
        const effectiveStagnantScrolls = autoScrollAll ? 50 : 5;

        const scanOptions = {
            maxScrolls: effectiveMaxScrolls,
            maxStagnantScrolls: effectiveStagnantScrolls,
            adaptiveDelay: options.adaptiveDelay !== false,
            autoScrollAll,
            onProgress: (progress) => {
                // Update scan data with real-time groups
                const scanData = activeScans.get(scanId);
                if (scanData && progress.groups) {
                    scanData.groups = progress.groups;
                    scanData.stats = {
                        scrolled: progress.scrollCount,
                        totalGroups: progress.totalGroups,
                        networkHealth: progress.networkHealth
                    };
                }
                broadcastLog(`📊 Scan ${scanId}: Scrolled ${progress.scrollCount}, found ${progress.totalGroups} groups`, 'info');
            }
        };

        // Initialize scan entry
        activeScans.set(scanId, {
            id: scanId,
            accountId,
            status: 'running',
            groups: [],
            stats: {},
            startedAt: new Date().toISOString(),
            browser: null,
            abortController: new AbortController()
        });

        res.json({ success: true, scanId, message: 'Scan started' });

        // Run scan in background
        (async () => {
            let browser, page;
            try {
                broadcastLog(`🔍 Starting group scan for account: ${account.name}`, 'info');

                // Launch browser with account cookies
                const cookies = typeof account.cookies_json === 'string'
                    ? JSON.parse(account.cookies_json)
                    : account.cookies_json;

                const launchResult = await launchBrowserWithCookies(null, {
                    cookiesOverride: cookies
                });
                browser = launchResult.browser;
                page = launchResult.page;

                // Update scan with browser reference for cancellation
                const scan = activeScans.get(scanId);
                if (scan) scan.browser = browser;

                // Run the scan
                const result = await scanJoinedGroups(page, {
                    ...scanOptions,
                    signal: activeScans.get(scanId)?.abortController.signal
                });

                // Update scan results
                const scanData = activeScans.get(scanId);
                if (scanData) {
                    scanData.status = 'completed';
                    scanData.groups = result.groups || [];
                    scanData.stats = result.stats || {};
                    scanData.completedAt = new Date().toISOString();
                }

                broadcastLog(`✅ Scan ${scanId} complete! Found ${result.groups?.length || 0} groups`, 'success');

            } catch (error) {
                broadcastLog(`❌ Scan ${scanId} failed: ${error.message}`, 'error');
                const scanData = activeScans.get(scanId);
                if (scanData) {
                    scanData.status = 'failed';
                    scanData.error = error.message;
                    scanData.completedAt = new Date().toISOString();
                }
            } finally {
                if (browser) {
                    try {
                        await browser.close();
                    } catch (e) {
                        console.error('Error closing browser:', e.message);
                    }
                }
            }
        })();

    } catch (error) {
        console.error('❌ Error starting scan:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /api/groups/scan/:scanId - Get scan results/status
app.get('/api/groups/scan/:scanId', async (req, res) => {
    try {
        const { scanId } = req.params;
        const scanData = activeScans.get(scanId);

        if (!scanData) {
            return res.status(404).json({ success: false, error: 'Scan not found' });
        }

        res.json({
            success: true,
            status: scanData.status,
            groups: scanData.groups,
            stats: scanData.stats,
            startedAt: scanData.startedAt,
            completedAt: scanData.completedAt,
            error: scanData.error || null
        });

    } catch (error) {
        console.error('❌ Error getting scan results:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/groups/scan/:scanId/cancel - Cancel an ongoing scan
app.post('/api/groups/scan/:scanId/cancel', async (req, res) => {
    try {
        const { scanId } = req.params;
        const scanData = activeScans.get(scanId);

        if (!scanData) {
            return res.status(404).json({ success: false, error: 'Scan not found' });
        }

        if (scanData.status !== 'running') {
            return res.status(400).json({ success: false, error: `Scan is already ${scanData.status}` });
        }

        // Signal cancellation
        scanData.abortController.abort();
        scanData.status = 'cancelled';
        scanData.completedAt = new Date().toISOString();

        // Close browser if open
        if (scanData.browser) {
            try {
                await scanData.browser.close();
            } catch (e) {
                console.error('Error closing browser during cancellation:', e.message);
            }
        }

        broadcastLog(`⚠️ Scan ${scanId} cancelled by user`, 'warning');

        res.json({ success: true, message: 'Scan cancelled' });

    } catch (error) {
        console.error('❌ Error cancelling scan:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /api/groups/save - Save scanned groups to database
app.post('/api/groups/save', async (req, res) => {
    try {
        const { accountId, groups } = req.body;

        console.log('🔍 [DEBUG] /api/groups/save received:');
        console.log('  - accountId:', accountId, typeof accountId);
        console.log('  - groups count:', groups?.length);
        console.log('  - first group sample:', JSON.stringify(groups?.[0], null, 2));

        if (!accountId) {
            return res.status(400).json({ success: false, error: 'Account ID is required' });
        }

        if (!groups || !Array.isArray(groups)) {
            console.error('❌ [DEBUG] Invalid groups data:', typeof groups, groups);
            return res.status(400).json({ success: false, error: 'Groups array is required' });
        }

        let saved = 0;
        let duplicates = 0;
        let errors = 0;
        let blacklisted = 0;

        // Ambil daftar blacklist sekali saja (bukan query per grup)
        let blacklistedIds = new Set();
        try {
            blacklistedIds = new Set(await GroupBlacklist.getGroupIds(accountId));
        } catch (e) {
            console.error('[groups/save] Gagal memuat blacklist:', e.message);
        }

        for (let i = 0; i < groups.length; i++) {
            const group = groups[i];
            try {
                // FIX: Properly map field names from scan results
                // scanJoinedGroups returns: group_id, group_name, group_url, member_count, member_count_raw, group_type, avatar_url, is_joined, scanned_at
                const groupData = {
                    facebook_account_id: accountId,
                    group_id: group.group_id || group.id,
                    group_name: group.group_name || group.name || `Group ${group.group_id || group.id || i}`,
                    group_type: group.group_type || group.privacy || 'unknown',
                    member_count: (group.member_count_raw !== undefined && group.member_count_raw !== null) ? group.member_count_raw : 0,
                    category: group.category || null,
                    is_joined: group.is_joined !== undefined ? group.is_joined : true,
                    status: 'active'
                };

                // Validate required fields before saving
                if (!groupData.group_id) {
                    console.error(`❌ [DEBUG] Group ${i+1} missing group_id, skipping:`, JSON.stringify(group));
                    errors++;
                    continue;
                }

                // Grup blacklist tidak boleh masuk lagi ke Manajemen Grup
                if (blacklistedIds.has(String(groupData.group_id))) {
                    blacklisted++;
                    continue;
                }

                console.log(`🔍 [DEBUG] Group ${i+1}/${groups.length} - groupData:`, JSON.stringify(groupData, null, 2));

                const result = await Group.save(groupData);
                console.log(`🔍 [DEBUG] Group.save() returned:`, result, typeof result);

                if (result !== null && result !== undefined) {
                    saved++;
                } else {
                    console.warn(`⚠️ [DEBUG] Group.save() returned unexpected falsy value for group: ${groupData.group_name}`);
                    errors++;
                }
            } catch (e) {
                console.error(`❌ [DEBUG] Error saving group ${i+1} (${group?.group_name || group?.name || 'unknown'}):`, e.message);
                if (e.message && (e.message.includes('duplicate') || e.message.includes('UNIQUE') || e.message.includes('unique') || e.message.includes('PRIMARY KEY'))) {
                    duplicates++;
                } else {
                    errors++;
                }
            }
        }

        console.log(`🔍 [DEBUG] Save summary: saved=${saved}, duplicates=${duplicates}, errors=${errors}, blacklisted=${blacklisted}, total=${groups.length}`);

        broadcastLog(`✅ Saved ${saved} groups, ${duplicates} duplicates skipped, ${errors} errors, ${blacklisted} blacklisted skipped`, 'success');

        res.json({ success: true, saved, duplicates, errors, blacklisted });

    } catch (error) {
        console.error('❌ Error saving groups:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ POST NOW API WITH VARIABLE DELAY ============

app.post('/api/post-now', async (req, res) => {
    const { account_id, post_type, content, link_url, image_paths, target_groups, delay_seconds = 120, use_variable_delay = true } = req.body;

    if (isPosting) {
        return res.status(400).json({ success: false, error: 'Posting already in progress' });
    }

    if (!account_id || !target_groups || target_groups.length === 0) {
        return res.status(400).json({ success: false, error: 'Account ID and target groups are required' });
    }

    res.json({ success: true, message: 'Posting started', totalGroups: target_groups.length });

    isPosting = true;
    resetPostControl();
    postControl.active = true;
    resetActivePostJob(target_groups.length);

    // Run in background
    (async () => {
        let browser, page;
        const results = {
            success: [],
            failed: [],
            pending: [],
            spamDetected: false
        };

        try {
            const account = await Account.getById(account_id);
            if (!account) throw new Error('Account not found');

            broadcastLog(`🚀 Starting bulk posting to ${target_groups.length} groups`, 'info');
            broadcastLog(`📋 Using account: ${account.name} (ID: ${account.id})`, 'info');
            
            // Parse cookies if stored as string
            let cookies = account.cookies_json;
            if (typeof cookies === 'string') {
                try {
                    cookies = JSON.parse(cookies);
                } catch (e) {
                    console.error('Failed to parse cookies:', e.message);
                }
            }
            
            if (cookies && Array.isArray(cookies)) {
                console.log(`[post-now] Found ${cookies.length} cookies for account`);
            } else {
                console.error('[post-now] No valid cookies found for account!');
            }

            // Launch browser with account cookies
            const launchResult = await launchBrowserWithCookies(null, {
                cookiesOverride: cookies
            });
            browser = launchResult.browser;
            page = launchResult.page;

            // Auto-pause 1 jam saat terdeteksi SPAM atau
            // "Network request timed out. ComposerStoryCreateMutation(...)".
            // Setelah 1 jam, progres dilanjutkan OTOMATIS dari grup yang sama.
            // Jika terdeteksi lagi → auto-pause 1 jam lagi, dan begitu seterusnya
            // TANPA batas retry.
            const AUTO_PAUSE_MIN = Math.floor(AUTO_PAUSE_MS / 60000);
            let autoPauseCount = 0; // hanya untuk penomoran di log

            // Post to each group — support resume after spam cooldown
            let i = 0;
            let sessionAborted = false;
            while (i < target_groups.length) {
                // Cek permintaan STOP dari pengguna
                if (postControl.stopped) {
                    broadcastLog('🛑 Posting dihentikan oleh pengguna.', 'warning');
                    break;
                }

                // Tunggu selama di-PAUSE
                if (await waitWhilePaused()) {
                    broadcastLog('🛑 Posting dihentikan oleh pengguna.', 'warning');
                    break;
                }

                const groupId = target_groups[i];
                const progress = `[${i + 1}/${target_groups.length}]`;

                broadcastLog(`${progress} Posting to group ${groupId}...`, 'info');

                try {
                    const result = await postToGroup(page, groupId, content, image_paths || [], {
                        maxRetries: 3,
                        retryDelay: 5000,
                        onProgress: (status) => broadcastLog(`${progress} ${status.status}`, 'info')
                    });

                    // Log to post history
                    // Catatan: SEMUA hasil (sukses / gagal / grup nonaktif / sesi expired)
                    // HARUS disimpan ke history agar tidak ada kejadian "hilang" diam-diam.
                    let historyStatus = 'failed';
                    if (result.success) historyStatus = result.pendingApproval ? 'pending_approval' : 'success';
                    else if (result.groupDisabled) historyStatus = 'group_disabled';
                    else if (result.sessionInvalid) historyStatus = 'session_invalid';

                    // Jangan catat history untuk SPAM / network timeout: grup ini akan
                    // dicoba ulang otomatis setelah auto-pause, jadi bukan kegagalan final.
                    const willRetryAfterPause = !result.success &&
                        (result.spamDetected || result.networkTimeout);
                    if (!willRetryAfterPause) {
                        try {
                            await PostHistory.create({
                                facebook_account_id: account_id,
                                group_id: groupId,
                                post_content: content,
                                image_paths: image_paths || [],
                                status: historyStatus,
                                error_message: result.error || null,
                                posted_at: new Date(),
                                approval_status: result.pendingApproval ? 'pending' : 'auto_posted'
                            });
                        } catch (historyErr) {
                            broadcastLog(`⚠️ Gagal menyimpan history ${groupId}: ${historyErr.message}`, 'warning');
                        }
                    }

                    if (result.success) {
                        if (result.pendingApproval) {
                            results.pending.push({ groupId, attempts: result.attempts });
                            activePostJob.pending = results.pending.length;
                            activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                            broadcastLog(`${progress} ⏳ Pending approval: ${groupId}`, 'warning');
                        } else {
                            results.success.push({ groupId, attempts: result.attempts });
                            activePostJob.success = results.success.length;
                            activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                            broadcastLog(`${progress} ✅ Success: ${groupId}`, 'success');
                        }
                        i++; // lanjut ke grup berikutnya
                    } else if (result.sessionInvalid) {
                        // Sesi login/cookies habis — hentikan SEMUA sisa grup, tidak ada gunanya lanjut.
                        // Keluar dari while agar tidak menulis history gagal untuk grup yang tidak diproses.
                        results.failed.push({ groupId, error: result.error, sessionInvalid: true });
                        activePostJob.failed = results.failed.length;
                        activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                        broadcastLog(`🔐 SESI LOGIN EXPIRED pada grup ${groupId}. Posting dihentikan.`, 'error');
                        broadcastLog(`👉 Perbarui cookies akun (halaman Akun → Update Cookies) lalu coba lagi.`, 'error');
                        sessionAborted = true;
                        break;
                    } else if (result.groupDisabled) {
                        // Grup dinonaktifkan / chat ditutup — skip tanpa delay
                        results.failed.push({ groupId, error: result.error });
                        activePostJob.failed = results.failed.length;
                        activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                        broadcastLog(`${progress} 🚫 SKIP (grup nonaktif): ${groupId} — ${result.error}`, 'warning');
                        i++;
                        continue; // langsung ke grup berikutnya tanpa delay
                    } else if (result.blacklist || result.postBoxNotFound) {
                        // Grup tidak punya post box di halaman utama → BLACKLIST.
                        // Hapus dari daftar Manajemen Grup agar tidak dipakai lagi.
                        results.failed.push({ groupId, error: result.error, blacklisted: true });
                        activePostJob.failed = results.failed.length;
                        activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                        broadcastLog(`${progress} 🚫 BLACKLIST: ${groupId} — ${result.error || 'Post box tidak ditemukan di halaman utama'}`, 'warning');
                        await blacklistGroup(groupId, account_id, null, result.error, broadcastLog);
                        i++;
                        continue; // langsung ke grup berikutnya tanpa delay
                    } else if (result.spamDetected || result.networkTimeout) {
                        // ===== AUTO-PAUSE 1 JAM (SPAM / NETWORK TIMEOUT) =====
                        // Tidak ada batas retry: setelah 1 jam progres lanjut otomatis,
                        // jika terdeteksi lagi maka auto-pause 1 jam lagi, berulang terus.
                        autoPauseCount++;
                        const isSpam = !!result.spamDetected;
                        const reason = isSpam
                            ? 'SPAM / akun dibatasi Facebook'
                            : 'Network request timed out (ComposerStoryCreateMutation)';
                        const until = new Date(Date.now() + AUTO_PAUSE_MS);

                        postControl.autoPaused = true;
                        postControl.autoPauseUntil = until.toISOString();
                        postControl.autoPauseReason = reason;

                        broadcastLog(`⏸️ ${reason} pada grup ${groupId}.`, 'error');
                        broadcastLog(`⏱️ AUTO-PAUSE ${AUTO_PAUSE_MIN} menit (sampai ${until.toLocaleTimeString()}) — progres lanjut otomatis setelahnya. (auto-pause #${autoPauseCount})`, 'warning');

                        // Countdown per menit; tetap bisa di-STOP pengguna kapan saja.
                        for (let t = AUTO_PAUSE_MIN; t > 0; t--) {
                            if (await interruptibleDelay(60000)) break;
                            if (t > 1) {
                                broadcastLog(`⏱️ Auto-pause: ${t - 1} menit lagi... (auto-pause #${autoPauseCount})`, 'warning');
                            }
                        }

                        postControl.autoPaused = false;
                        postControl.autoPauseUntil = null;
                        postControl.autoPauseReason = null;

                        if (postControl.stopped) {
                            broadcastLog('🛑 Posting dihentikan oleh pengguna saat auto-pause.', 'warning');
                            break;
                        }

                        broadcastLog(`🔄 Auto-pause selesai. Melanjutkan progres dari grup ${groupId}...`, 'info');
                        // Tidak increment i — coba ulang grup yang sama
                    } else {
                        results.failed.push({ groupId, error: result.error });
                        activePostJob.failed = results.failed.length;
                        activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                        broadcastLog(`${progress} ❌ Failed: ${groupId} - ${result.error}`, 'error');
                        i++;
                    }

                } catch (err) {
                    const isBlacklistErr = /post box tidak ditemukan/i.test(err.message || '');
                    results.failed.push({ groupId, error: err.message, blacklisted: isBlacklistErr });
                    activePostJob.failed = results.failed.length;
                    activePostJob.current = results.success.length + results.pending.length + results.failed.length;
                    broadcastLog(`${progress} ❌ Error: ${groupId} - ${err.message}`, 'error');

                    // "Post box tidak ditemukan" → grup blacklist, hapus dari Manajemen Grup.
                    if (isBlacklistErr) {
                        await blacklistGroup(groupId, account_id, null, err.message, broadcastLog);
                    }

                    // Selalu simpan history walau terjadi exception, agar tidak ada
                    // kejadian yang hilang tanpa jejak (mis. saat sesi expired).
                    try {
                        await PostHistory.create({
                            facebook_account_id: account_id,
                            group_id: groupId,
                            post_content: content,
                            image_paths: image_paths || [],
                            status: /sesi|cookies|login/i.test(err.message) ? 'session_invalid' : 'failed',
                            error_message: err.message,
                            posted_at: new Date()
                        });
                    } catch (historyErr) {
                        broadcastLog(`⚠️ Gagal menyimpan history ${groupId}: ${historyErr.message}`, 'warning');
                    }
                    i++;
                }

                // Variable delay antar grup (anti-detection), skip jika spam cooldown baru selesai
                if (i < target_groups.length) {
                    const baseDelay = delay_seconds * 1000;
                    const randomVariation = use_variable_delay ? Math.floor(Math.random() * 30000) : 0;
                    const totalDelay = baseDelay + randomVariation;

                    broadcastLog(`⏳ Waiting ${Math.floor(totalDelay/1000)}s (base: ${delay_seconds}s + random: ${Math.floor(randomVariation/1000)}s)...`, 'warning');
                    if (await interruptibleDelay(totalDelay)) {
                        broadcastLog('🛑 Posting dihentikan oleh pengguna saat jeda antar grup.', 'warning');
                        break;
                    }
                }
            }

            await browser.close();

            // Final report
            if (sessionAborted) {
                broadcastLog(`📊 POSTING DIHENTIKAN — sesi login/cookies expired atau logout.`, 'error');
                broadcastLog(`👉 Perbarui cookies akun lalu jalankan lagi. Grup yang diproses tercatat di Riwayat.`, 'error');
            } else if (postControl.stopped) {
                broadcastLog(`📊 POSTING DIHENTIKAN oleh pengguna:`, 'warning');
            } else {
                broadcastLog(`📊 POSTING COMPLETE:`, 'info');
            }
            broadcastLog(`   ✅ Success: ${results.success.length}`, 'success');
            broadcastLog(`   ⏳ Pending: ${results.pending.length}`, 'warning');
            broadcastLog(`   ❌ Failed: ${results.failed.length}`, 'error');
            if (autoPauseCount > 0) {
                broadcastLog(`   ⏸️ Auto-pause (spam/network timeout): ${autoPauseCount}x @ 1 jam`, 'warning');
            }
            const remaining = target_groups.length - results.success.length - results.pending.length - results.failed.length;
            if (remaining > 0) {
                broadcastLog(`   ⏭️ Tidak diproses: ${remaining} grup`, 'warning');
            }

        } catch (error) {
            broadcastLog(`❌ Fatal error: ${error.message}`, 'error');
            if (browser) await browser.close();
        } finally {
            isPosting = false;
            resetPostControl();
            // Tandai job selesai agar halaman yang di-refresh tahu posting sudah berakhir
            activePostJob.active = false;
            activePostJob.finished = true;
            activePostJob.finishedAt = new Date().toISOString();
            activePostJob.current = activePostJob.success + activePostJob.pending + activePostJob.failed;
        }
    })();
});

// Snapshot progress + log job posting (dipakai untuk memulihkan tampilan setelah refresh)
app.get('/api/post-now/current', (req, res) => {
    res.json({
        success: true,
        active: isPosting,
        job: {
            active: activePostJob.active,
            finished: activePostJob.finished,
            startedAt: activePostJob.startedAt,
            finishedAt: activePostJob.finishedAt,
            total: activePostJob.total,
            current: activePostJob.current,
            success: activePostJob.success,
            pending: activePostJob.pending,
            failed: activePostJob.failed,
            logs: activePostJob.logs,
            summary: activePostJob.summary
        },
        paused: postControl.paused,
        stopped: postControl.stopped,
        autoPaused: postControl.autoPaused,
        autoPauseUntil: postControl.autoPauseUntil,
        autoPauseReason: postControl.autoPauseReason
    });
});

// ============ POST CONTROL (PAUSE / RESUME / STOP) ============

app.post('/api/post-now/pause', (req, res) => {
    if (!isPosting) {
        return res.status(400).json({ success: false, error: 'Tidak ada posting yang sedang berjalan' });
    }
    postControl.paused = true;
    broadcastLog('⏸️ Posting dijeda oleh pengguna. Klik Resume untuk melanjutkan.', 'warning');
    res.json({ success: true, paused: true, stopped: postControl.stopped });
});

app.post('/api/post-now/resume', (req, res) => {
    if (!isPosting) {
        return res.status(400).json({ success: false, error: 'Tidak ada posting yang sedang berjalan' });
    }
    postControl.paused = false;
    if (postControl.resumeResolve) {
        postControl.resumeResolve();
        postControl.resumeResolve = null;
    }
    broadcastLog('▶️ Posting dilanjutkan oleh pengguna.', 'info');
    res.json({ success: true, paused: false, stopped: postControl.stopped });
});

app.post('/api/post-now/stop', (req, res) => {
    if (!isPosting) {
        return res.status(400).json({ success: false, error: 'Tidak ada posting yang sedang berjalan' });
    }
    postControl.stopped = true;
    postControl.paused = false; // lepaskan pause agar loop bisa keluar
    if (postControl.resumeResolve) {
        postControl.resumeResolve();
        postControl.resumeResolve = null;
    }
    broadcastLog('🛑 Permintaan STOP diterima. Menghentikan posting...', 'warning');
    res.json({ success: true, paused: false, stopped: true });
});

app.get('/api/post-now/status', (req, res) => {
    res.json({
        success: true,
        isPosting,
        paused: postControl.paused,
        stopped: postControl.stopped,
        autoPaused: postControl.autoPaused,
        autoPauseUntil: postControl.autoPauseUntil,
        autoPauseReason: postControl.autoPauseReason
    });
});

// ============ DASHBOARD STATS ============

app.get('/api/dashboard-stats', async (req, res) => {
    try {
        const accounts = await Account.getAll();
        const scheduled = await ScheduledPost.getAll();
        const postStats = await PostHistory.getStats();

        const stats = {
            totalAccounts: accounts.length,
            activeAccounts: accounts.filter(a => a.status === 'active').length,
            totalScheduled: scheduled.length,
            pendingScheduled: scheduled.filter(p => p.status === 'scheduled').length,
            publishedToday: postStats.today || 0,
            failedToday: 0,
            totalPosts: postStats.total || 0,
            successRate: postStats.total > 0 ? Math.round((postStats.success / postStats.total) * 100) : 0
        };

        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ EXPORT/IMPORT API ============

app.get('/api/export/accounts', async (req, res) => {
    try {
        const accounts = await Account.getAll();
        const sanitized = accounts.map(a => ({
            id: a.id,
            name: a.name,
            facebook_id: a.facebook_id,
            email: a.email,
            status: a.status,
            created_at: a.created_at
        }));

        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', 'attachment; filename=accounts.json');
        res.json(sanitized);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/export/groups/:accountId', async (req, res) => {
    try {
        const groups = await Group.getAll({ account_id: req.params.accountId });

        const fields = ['group_id', 'group_name', 'group_type', 'member_count', 'category', 'is_joined', 'status'];
        const parser = new Parser({ fields });
        const csv = parser.parse(groups);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=groups.csv');
        res.send(csv);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/import/groups/:accountId', async (req, res) => {
    try {
        const { groups } = req.body;
        const accountId = req.params.accountId;

        if (!Array.isArray(groups)) {
            return res.status(400).json({ success: false, error: 'Invalid data format' });
        }

        const enriched = groups.map(g => ({
            ...g,
            facebook_account_id: accountId
        }));

        const imported = await Group.bulkInsert(enriched);

        res.json({ success: true, imported });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ TEMPLATES API ============

app.get('/api/templates', async (req, res) => {
    try {
        const templates = await Template.getAll(req.query);
        res.json({ success: true, templates });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/templates/categories', async (req, res) => {
    try {
        const categories = await Template.getCategories();
        res.json({ success: true, categories });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/templates/:id', async (req, res) => {
    try {
        const template = await Template.getById(req.params.id);
        if (!template) {
            return res.status(404).json({ success: false, error: 'Template not found' });
        }
        res.json({ success: true, template });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/templates', async (req, res) => {
    try {
        const templateId = await Template.create(req.body);
        res.json({ success: true, templateId });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/templates/:id', async (req, res) => {
    try {
        const updated = await Template.update(req.params.id, req.body);
        res.json({ success: updated });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/templates/:id', async (req, res) => {
    try {
        const deleted = await Template.delete(req.params.id);
        res.json({ success: deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/templates/:id/use', async (req, res) => {
    try {
        await Template.incrementUseCount(req.params.id);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ POST HISTORY API ============

app.get('/api/post-history', async (req, res) => {
    try {
        const { page = 1, limit = 50, ...filters } = req.query;
        const history = await PostHistory.getAll(filters, page, limit);
        res.json({ success: true, ...history });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post-history/stats', async (req, res) => {
    try {
        const stats = await PostHistory.getStats(req.query.account_id);
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/post-history/daily', async (req, res) => {
    try {
        const { days = 30, account_id } = req.query;
        const daily = await PostHistory.getDailyStats(days, account_id);
        res.json({ success: true, daily });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post-history/cleanup', async (req, res) => {
    try {
        const deleted = await PostHistory.deleteOld(90);
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/post-history/clear-all', async (req, res) => {
    try {
        const deleted = await PostHistory.deleteAll();
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SETTINGS API ============

app.get('/api/settings', async (req, res) => {
    try {
        const settings = await query('SELECT setting_key, setting_value FROM settings');
        const result = {};
        settings.forEach(s => {
            result[s.setting_key] = s.setting_value;
        });
        res.json({ success: true, settings: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/settings', async (req, res) => {
    try {
        const settings = req.body;
        for (const [key, value] of Object.entries(settings)) {
            await query(
                'INSERT INTO settings (setting_key, setting_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE setting_value = ?',
                [key, value, value]
            );
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ BACKUP/RESTORE API ============

app.get('/api/backup', async (req, res) => {
    try {
        const accounts = await Account.getAll();
        const groups = await Group.getAll({});
        const templates = await Template.getAll({});
        const settings = await query('SELECT * FROM settings');

        const backup = {
            version: '2.0',
            created_at: new Date().toISOString(),
            accounts,
            groups,
            templates,
            settings
        };

        res.json({ success: true, backup });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/restore', async (req, res) => {
    try {
        const backup = req.body;

        if (backup.accounts) {
            for (const acc of backup.accounts) {
                await Account.create(acc);
            }
        }

        if (backup.groups) {
            for (const group of backup.groups) {
                await Group.create(group);
            }
        }

        if (backup.templates) {
            for (const template of backup.templates) {
                await Template.create(template);
            }
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/reset', async (req, res) => {
    try {
        await query(`DELETE FROM post_history WHERE posted_at < datetime('now', '-90 days')`);
        await query('DELETE FROM scheduled_posts');
        await query('DELETE FROM fb_groups');
        await query('DELETE FROM post_templates');
        await query('DELETE FROM facebook_accounts');
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ SCHEDULER ============

async function executeScheduledPost(post) {
    let browser, page;

    try {
        broadcastLog(`⏰ Executing scheduled post #${post.id}`, 'info');

        const account = await Account.getById(post.facebook_account_id);
        if (!account) {
            throw new Error('Account not found');
        }

        await ScheduledPost.updateStatus(post.id, 'processing');

        const launchResult = await launchBrowserWithCookies(null, {
            cookiesOverride: account.cookies_json
        });
        browser = launchResult.browser;
        page = launchResult.page;

        const targetIds = JSON.parse(post.target_ids || '[]');
        const imagePaths = JSON.parse(post.image_paths || '[]');

        for (let i = 0; i < targetIds.length; i++) {
            const groupId = targetIds[i];

            try {
                const result = await postToGroup(page, groupId, post.content, imagePaths, {
                    maxRetries: 3,
                    retryDelay: 5000
                });

                await PostHistory.create({
                    facebook_account_id: post.facebook_account_id,
                    group_id: groupId,
                    scheduled_post_id: post.id,
                    post_content: post.content,
                    image_paths: imagePaths,
                    status: result.success ? (result.pendingApproval ? 'pending_approval' : 'success') : 'failed',
                    error_message: result.error || null,
                    posted_at: new Date()
                });

                if (result.success) {
                    broadcastLog(`✅ Posted to ${groupId}`, 'success');
                } else if (result.spamDetected) {
                    broadcastLog(`🛑 Spam detected, stopping`, 'error');
                    break;
                } else {
                    broadcastLog(`❌ Failed ${groupId}: ${result.error}`, 'error');
                }

                if (i < targetIds.length - 1) {
                    await delay(120000 + Math.floor(Math.random() * 30000));
                }

            } catch (err) {
                broadcastLog(`❌ Error ${groupId}: ${err.message}`, 'error');
                await PostHistory.create({
                    facebook_account_id: post.facebook_account_id,
                    group_id: groupId,
                    scheduled_post_id: post.id,
                    post_content: post.content,
                    status: 'failed',
                    error_message: err.message,
                    posted_at: new Date()
                });
            }
        }

        await browser.close();
        await ScheduledPost.updateStatus(post.id, 'published');
        broadcastLog(`✅ Scheduled post #${post.id} completed`, 'success');

    } catch (error) {
        broadcastLog(`❌ Scheduled post #${post.id} failed: ${error.message}`, 'error');
        await ScheduledPost.updateStatus(post.id, 'failed', error.message);
        if (browser) await browser.close();
    }
}

cron.schedule('* * * * *', async () => {
    if (isPosting) return;

    try {
        const pendingPosts = await ScheduledPost.getPending();

        for (const post of pendingPosts) {
            await executeScheduledPost(post);
        }
    } catch (error) {
        console.error('Scheduler error:', error.message);
    }
});

// ============ POST PROGRESS API ============

const postJobs = {};

app.get('/api/post-progress/:jobId', async (req, res) => {
    try {
        const job = postJobs[req.params.jobId];
        if (!job) {
            return res.json({ done: true, success: false, error: 'Job not found' });
        }
        res.json(job);
    } catch (error) {
        res.status(500).json({ done: true, success: false, error: error.message });
    }
});

// ============ SIMPLE POST API (for post-simple.html) ============

app.post('/api/post-now-simple', async (req, res) => {
    try {
        const { account_id, content, image_paths, target_groups } = req.body;

        if (!account_id || !content || !target_groups || target_groups.length === 0) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }

        // Create job
        const jobId = Date.now().toString();
        postJobs[jobId] = {
            done: false,
            current: 0,
            total: target_groups.length,
            success: 0,
            failed: 0,
            lastLog: 'Starting...',
            logType: 'info'
        };

        // Post in background
        (async () => {
            let browser;
            try {
                const account = await Account.getById(account_id);
                if (!account) {
                    postJobs[jobId] = { done: true, success: false, error: 'Account not found' };
                    return;
                }

                let cookies = typeof account.cookies_json === 'string'
                    ? JSON.parse(account.cookies_json)
                    : account.cookies_json;

                const { launchBrowserWithCookies, postToGroup, delay } = require('./fbPosterCore');
                const result = await launchBrowserWithCookies(null, { cookiesOverride: cookies });
                browser = result.browser;
                const page = result.page;

                for (let i = 0; i < target_groups.length; i++) {
                    const groupId = target_groups[i];
                    postJobs[jobId].lastLog = `Posting to ${groupId}...`;
                    postJobs[jobId].logType = 'info';

                    try {
                        const postResult = await postToGroup(page, groupId, content, image_paths || [], {
                            maxRetries: 2,
                            retryDelay: 3000
                        });

                        if (postResult.success) {
                            postJobs[jobId].success++;
                            postJobs[jobId].lastLog = `✅ Posted to ${groupId}`;
                            postJobs[jobId].logType = 'success';
                        } else {
                            postJobs[jobId].failed++;
                            postJobs[jobId].lastLog = `❌ Failed ${groupId}: ${postResult.error}`;
                            postJobs[jobId].logType = 'error';
                        }
                    } catch (err) {
                        postJobs[jobId].failed++;
                        postJobs[jobId].lastLog = `❌ Error ${groupId}: ${err.message}`;
                        postJobs[jobId].logType = 'error';
                    }

                    postJobs[jobId].current = i + 1;

                    // Delay between posts
                    if (i < target_groups.length - 1) {
                        await delay(30000 + Math.floor(Math.random() * 15000));
                    }
                }

                postJobs[jobId].done = true;
                postJobs[jobId].success = postJobs[jobId].success > 0;
                postJobs[jobId].lastLog = 'Posting selesai!';
                postJobs[jobId].logType = 'success';

            } catch (error) {
                postJobs[jobId] = { done: true, success: false, error: error.message };
            } finally {
                if (browser) await browser.close();
            }
        })();

        res.json({ success: true, jobId, totalGroups: target_groups.length });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ GLOBAL ERROR HANDLER ============
// This MUST be after all routes to catch any unhandled errors
app.use((err, req, res, next) => {
    console.error('[Global Error Handler] Unhandled error:', err);

    // Always return JSON, never HTML
    if (!res.headersSent) {
        res.status(err.status || 500).json({
            success: false,
            error: err.message || 'Internal server error',
            path: req.path
        });
    }
});

// ============ START SERVER ============

async function startServer() {
    const dbInitialized = await initializeDatabase();
    if (!dbInitialized) {
        console.error('❌ Failed to initialize database');
        process.exit(1);
    }

console.log("__dirname:", __dirname);
console.log("img path:", path.join(__dirname, "img"));
console.log("img exists:", require("fs").existsSync(path.join(__dirname, "img")));
    server.listen(PORT, () => {
        console.log('╔════════════════════════════════════════════════╗');
        console.log('║     🚀 FB AUTO POSTER PRO v2.0 - SERVER        ║');
        console.log('╠════════════════════════════════════════════════╣');
        console.log(`║  🌐 Dashboard: http://localhost:${PORT}         ║`);
        console.log('║  📊 API endpoints ready                          ║');
        console.log('║  ⏰ Scheduler running                            ║');
        console.log('╚════════════════════════════════════════════════╝');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await closePool();
    process.exit(0);
});

startServer();
