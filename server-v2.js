const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');
const cron = require('node-cron');
const crypto = require('crypto');

// Database
const { initializeDatabase, testConnection, closePool, query } = require('./database/connection');
const Account = require('./database/models/Account');
const ScheduledPost = require('./database/models/ScheduledPost');
const Group = require('./database/models/Group');
const Template = require('./database/models/Template');
const PostHistory = require('./database/models/PostHistory');

// Core functions
const { launchBrowserWithCookies, postToGroup, delay } = require('./fbPosterCore');
const { scrapeJoinedGroups, searchGroupsByKeyword, joinGroup } = require('./fbScraper');
const { openFacebookForLogin, extractProfileFromCookies } = require('./fbLogin');
const puppeteer = require('puppeteer');

// Group scanner
const { scanJoinedGroups, searchAndJoinGroups } = require('./groupScanner');

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

const app = express();
const PORT = process.env.PORT || 8080;

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

app.use(express.static(path.join(__dirname, 'public-v2')));
app.use('/uploads', express.static(path.join(__dirname, 'web-dashboard', 'uploads')));


// Global state
let isPosting = false;
let currentJob = null;

// Scan tracking: scanId -> scan data
const activeScans = new Map();

// ============ WEBSOCKET BROADCAST ============
function broadcastLog(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${message}`);
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

                console.log(`🔍 [DEBUG] Group ${i+1}/${groups.length} - groupData:`, JSON.stringify(groupData, null, 2));

                const result = await Group.create(groupData);
                console.log(`🔍 [DEBUG] Group.create() returned:`, result, typeof result);

                // FIX: Group.create() returns:
                // - For new inserts: insertId (truthy number)
                // - For updates: affectedRows (can be 0 if no data changed)
                // Both are valid "success" cases - the operation completed without throwing
                if (result !== null && result !== undefined) {
                    saved++;
                } else {
                    console.warn(`⚠️ [DEBUG] Group.create() returned unexpected falsy value for group: ${groupData.group_name}`);
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

        console.log(`🔍 [DEBUG] Save summary: saved=${saved}, duplicates=${duplicates}, errors=${errors}, total=${groups.length}`);

        broadcastLog(`✅ Saved ${saved} groups, ${duplicates} duplicates skipped, ${errors} errors`, 'success');

        res.json({ success: true, saved, duplicates, errors });

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

            // Post to each group
            for (let i = 0; i < target_groups.length; i++) {
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
                    await PostHistory.create({
                        facebook_account_id: account_id,
                        group_id: groupId,
                        post_content: content,
                        image_paths: image_paths || [],
                        status: result.success ? (result.pendingApproval ? 'pending_approval' : 'success') : 'failed',
                        error_message: result.error || null,
                        posted_at: new Date(),
                        approval_status: result.pendingApproval ? 'pending' : 'auto_posted'
                    });

                    if (result.success) {
                        if (result.pendingApproval) {
                            results.pending.push({ groupId, attempts: result.attempts });
                            broadcastLog(`${progress} ⏳ Pending approval: ${groupId}`, 'warning');
                        } else {
                            results.success.push({ groupId, attempts: result.attempts });
                            broadcastLog(`${progress} ✅ Success: ${groupId}`, 'success');
                        }
                    } else if (result.spamDetected) {
                        results.spamDetected = true;
                        broadcastLog(`🛑 SPAM DETECTED! Stopping all posting.`, 'error');
                        break;
                    } else {
                        results.failed.push({ groupId, error: result.error });
                        broadcastLog(`${progress} ❌ Failed: ${groupId} - ${result.error}`, 'error');
                    }

                } catch (err) {
                    results.failed.push({ groupId, error: err.message });
                    broadcastLog(`${progress} ❌ Error: ${groupId} - ${err.message}`, 'error');

                    // Log error to history
                    await PostHistory.create({
                        facebook_account_id: account_id,
                        group_id: groupId,
                        post_content: content,
                        image_paths: image_paths || [],
                        status: 'failed',
                        error_message: err.message,
                        posted_at: new Date()
                    });
                }

                // Variable delay between posts (anti-detection)
                if (i < target_groups.length - 1 && !results.spamDetected) {
                    const baseDelay = delay_seconds * 1000;
                    const randomVariation = use_variable_delay ? Math.floor(Math.random() * 30000) : 0;
                    const totalDelay = baseDelay + randomVariation;

                    broadcastLog(`⏳ Waiting ${Math.floor(totalDelay/1000)}s (base: ${delay_seconds}s + random: ${Math.floor(randomVariation/1000)}s)...`, 'warning');
                    await delay(totalDelay);
                }
            }

            await browser.close();

            // Final report
            broadcastLog(`📊 POSTING COMPLETE:`, 'info');
            broadcastLog(`   ✅ Success: ${results.success.length}`, 'success');
            broadcastLog(`   ⏳ Pending: ${results.pending.length}`, 'warning');
            broadcastLog(`   ❌ Failed: ${results.failed.length}`, 'error');

        } catch (error) {
            broadcastLog(`❌ Fatal error: ${error.message}`, 'error');
            if (browser) await browser.close();
        } finally {
            isPosting = false;
        }
    })();
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
        await query('DELETE FROM post_history');
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
    app.listen(PORT, () => {
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
