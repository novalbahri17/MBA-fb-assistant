-- Facebook Auto Poster Pro - Database Schema
-- Database: testtfb

-- 1. Facebook Accounts Table
CREATE TABLE IF NOT EXISTS facebook_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    facebook_id VARCHAR(100),
    email VARCHAR(255),
    access_token TEXT,
    cookies_json LONGTEXT,
    profile_picture VARCHAR(500),
    status ENUM('active', 'inactive', 'blocked', 'error') DEFAULT 'active',
    last_used DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_status (status),
    INDEX idx_last_used (last_used)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Groups Table
CREATE TABLE IF NOT EXISTS `fb_groups` (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facebook_account_id INT NOT NULL,
    group_id VARCHAR(100) NOT NULL,
    group_name VARCHAR(500),
    group_type ENUM('public', 'private', 'closed') DEFAULT 'public',
    member_count INT DEFAULT 0,
    category VARCHAR(100),
    is_joined BOOLEAN DEFAULT FALSE,
    status ENUM('active', 'pending', 'blocked', 'left') DEFAULT 'active',
    last_posted DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    UNIQUE KEY unique_group (facebook_account_id, group_id),
    INDEX idx_account (facebook_account_id),
    INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Scheduled Posts Table
CREATE TABLE IF NOT EXISTS scheduled_posts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facebook_account_id INT NOT NULL,
    post_type ENUM('status', 'link', 'image', 'status_link', 'status_image', 'link_image', 'status_link_image') DEFAULT 'status',
    content TEXT,
    link_url VARCHAR(500),
    image_paths JSON,
    target_type ENUM('groups', 'pages', 'friends') DEFAULT 'groups',
    target_ids JSON,
    schedule_time DATETIME NOT NULL,
    timezone VARCHAR(50) DEFAULT 'Asia/Jakarta',
    status ENUM('scheduled', 'processing', 'published', 'failed', 'cancelled') DEFAULT 'scheduled',
    error_message TEXT,
    published_at DATETIME,
    retry_count INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    INDEX idx_status (status),
    INDEX idx_schedule_time (schedule_time),
    INDEX idx_account_status (facebook_account_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Post History Table
CREATE TABLE IF NOT EXISTS post_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facebook_account_id INT NOT NULL,
    scheduled_post_id INT,
    group_id INT,
    post_type VARCHAR(50),
    content TEXT,
    target_id VARCHAR(100),
    target_name VARCHAR(255),
    status ENUM('success', 'pending_approval', 'failed', 'blocked', 'deleted') DEFAULT 'success',
    error_message TEXT,
    facebook_post_id VARCHAR(100),
    posted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    FOREIGN KEY (scheduled_post_id) REFERENCES scheduled_posts(id) ON DELETE SET NULL,
    INDEX idx_account (facebook_account_id),
    INDEX idx_status (status),
    INDEX idx_posted_at (posted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Scraped Data Table
CREATE TABLE IF NOT EXISTS scraped_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facebook_account_id INT NOT NULL,
    scrape_type ENUM('groups', 'friends', 'group_members', 'pages', 'posts') NOT NULL,
    data_json LONGTEXT,
    keyword VARCHAR(255),
    scraped_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    INDEX idx_type (scrape_type),
    INDEX idx_account (facebook_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Settings Table
CREATE TABLE IF NOT EXISTS settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    setting_key VARCHAR(100) UNIQUE NOT NULL,
    setting_value TEXT,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. Post Templates Table
CREATE TABLE IF NOT EXISTS post_templates (
    id INT AUTO_INCREMENT PRIMARY KEY,
    facebook_account_id INT,
    name VARCHAR(255) NOT NULL,
    post_type ENUM('status', 'link', 'image', 'status_link', 'status_image', 'link_image', 'status_link_image') DEFAULT 'status',
    content TEXT,
    link_url VARCHAR(500),
    image_paths JSON,
    category VARCHAR(100) DEFAULT 'general',
    use_count INT DEFAULT 0,
    last_used DATETIME,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (facebook_account_id) REFERENCES facebook_accounts(id) ON DELETE CASCADE,
    INDEX idx_account (facebook_account_id),
    INDEX idx_category (category),
    INDEX idx_use_count (use_count)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Insert default settings
INSERT INTO settings (setting_key, setting_value) VALUES
('app_name', 'FB Auto Poster Pro'),
('version', '2.0'),
('max_daily_posts', '50'),
('post_interval_min', '60'),
('spam_protection', 'true')
ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value);
