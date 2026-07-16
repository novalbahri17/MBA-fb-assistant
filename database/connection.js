const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

// Database file path
const DB_PATH = path.join(__dirname, '..', 'fb_auto_poster.db');

// Create database directory if not exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

// Create and initialize database
let db = null;

function getDatabase() {
    if (!db) {
        db = new Database(DB_PATH, { verbose: console.log });
        console.log(`✅ SQLite database connected: ${DB_PATH}`);
    }
    return db;
}

// Execute query
function query(sql, params = []) {
    const database = getDatabase();
    
    try {
        console.log('📊 Database query:', sql.substring(0, 100) + (sql.length > 100 ? '...' : ''));
        console.log('📊 Query params:', params);
        
        // Check if it's a SELECT query
        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
        
        if (isSelect) {
            const stmt = database.prepare(sql);
            const result = params.length > 0 ? stmt.all(...params) : stmt.all();
            console.log('📊 Query result:', result?.length || 0, 'rows');
            return result;
        } else {
            const stmt = database.prepare(sql);
            const result = params.length > 0 ? stmt.run(...params) : stmt.run();
            console.log('📊 Query result:', result);
            return {
                insertId: result.lastInsertRowid,
                affectedRows: result.changes,
                ...result
            };
        }
    } catch (error) {
        console.error('❌ Database query error:', error.message);
        console.error('SQL:', sql);
        console.error('Params:', params);
        console.error('Full error:', error);
        throw error;
    }
}

// Initialize database tables
function initializeDatabase() {
    try {
        const database = getDatabase();

        // Read schema
        const schemaPath = path.join(__dirname, 'schema.sqlite.sql');
        let schema;

        if (fs.existsSync(schemaPath)) {
            schema = fs.readFileSync(schemaPath, 'utf8');
        } else {
            // Fallback to MySQL schema converted to SQLite
            schema = getSQLiteSchema();
        }

        // Execute schema
        database.exec(schema);

        // Add missing columns to post_templates table (migration)
        try {
            database.exec(`ALTER TABLE post_templates ADD COLUMN delay_seconds INTEGER DEFAULT 120`);
        } catch (e) { /* column already exists */ }
        try {
            database.exec(`ALTER TABLE post_templates ADD COLUMN use_variable_delay INTEGER DEFAULT 1`);
        } catch (e) { /* column already exists */ }

        console.log('✅ Database tables initialized');
        return true;
    } catch (error) {
        console.error('❌ Database initialization failed:', error.message);
        return false;
    }
}

// Test connection
function testConnection() {
    try {
        const database = getDatabase();
        const result = database.prepare('SELECT 1 as test').get();
        console.log('✅ Database connected:', result.test === 1);
        return true;
    } catch (error) {
        console.error('❌ Database connection failed:', error.message);
        return false;
    }
}

// Close database
function closePool() {
    if (db) {
        db.close();
        db = null;
        console.log('✅ Database connection closed');
    }
}

// SQLite schema (converted from MySQL)
function getSQLiteSchema() {
    return `
-- Facebook Auto Poster Pro - SQLite Schema

-- 1. Facebook Accounts Table
CREATE TABLE IF NOT EXISTS facebook_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    facebook_id TEXT,
    email TEXT,
    access_token TEXT,
    cookies_json TEXT,
    profile_picture TEXT,
    status TEXT DEFAULT 'active',
    last_used DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Groups Table
CREATE TABLE IF NOT EXISTS fb_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facebook_account_id INTEGER NOT NULL,
    group_id TEXT NOT NULL,
    group_name TEXT,
    group_type TEXT DEFAULT 'public',
    member_count INTEGER DEFAULT 0,
    category TEXT,
    is_joined BOOLEAN DEFAULT FALSE,
    status TEXT DEFAULT 'active',
    last_posted DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    UNIQUE(facebook_account_id, group_id)
);

-- 3. Scheduled Posts Table
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facebook_account_id INTEGER NOT NULL,
    post_type TEXT DEFAULT 'status',
    content TEXT,
    link_url TEXT,
    image_paths TEXT,
    target_type TEXT DEFAULT 'groups',
    target_ids TEXT,
    schedule_time DATETIME NOT NULL,
    timezone TEXT DEFAULT 'Asia/Jakarta',
    status TEXT DEFAULT 'scheduled',
    error_message TEXT,
    published_at DATETIME,
    retry_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE
);

-- 4. Post History Table
CREATE TABLE IF NOT EXISTS post_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facebook_account_id INTEGER NOT NULL,
    scheduled_post_id INTEGER,
    group_id INTEGER,
    post_type TEXT,
    content TEXT,
    target_id TEXT,
    target_name TEXT,
    status TEXT DEFAULT 'success',
    error_message TEXT,
    facebook_post_id TEXT,
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (scheduled_post_id) REFERENCES scheduled_posts(id) ON DELETE SET NULL
);

-- 5. Scraped Data Table
CREATE TABLE IF NOT EXISTS scraped_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facebook_account_id INTEGER NOT NULL,
    scrape_type TEXT NOT NULL,
    data_json TEXT,
    keyword TEXT,
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE
);

-- 6. Settings Table
CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setting_key TEXT UNIQUE NOT NULL,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Post Templates Table
CREATE TABLE IF NOT EXISTS post_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    facebook_account_id INTEGER,
    name TEXT NOT NULL,
    post_type TEXT DEFAULT 'status',
    content TEXT,
    link_url TEXT,
    image_paths TEXT,
    category TEXT DEFAULT 'general',
    delay_seconds INTEGER DEFAULT 120,
    use_variable_delay INTEGER DEFAULT 1,
    use_count INTEGER DEFAULT 0,
    last_used DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE
);

-- Insert default settings
INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES
('app_name', 'FB Auto Poster Pro'),
('version', '2.0'),
('max_daily_posts', '50'),
('post_interval_min', '60'),
('spam_protection', 'true');

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_accounts_status ON facebook_accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_last_used ON facebook_accounts(last_used);
CREATE INDEX IF NOT EXISTS idx_groups_account ON fb_groups(facebook_account_id);
CREATE INDEX IF NOT EXISTS idx_groups_status ON fb_groups(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_posts(status);
CREATE INDEX IF NOT EXISTS idx_scheduled_time ON scheduled_posts(schedule_time);
CREATE INDEX IF NOT EXISTS idx_history_account ON post_history(facebook_account_id);
CREATE INDEX IF NOT EXISTS idx_history_status ON post_history(status);
CREATE INDEX IF NOT EXISTS idx_history_posted_at ON post_history(posted_at);
CREATE INDEX IF NOT EXISTS idx_templates_account ON post_templates(facebook_account_id);
    `;
}

module.exports = {
    getDatabase,
    query,
    initializeDatabase,
    testConnection,
    closePool,
    DB_CONFIG: { path: DB_PATH }
};
