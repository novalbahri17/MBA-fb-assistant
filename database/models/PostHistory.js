const { query } = require('../connection');

class PostHistory {
    static async create(historyData) {
        const {
            facebook_account_id,
            group_id,
            post_content,
            image_paths,
            status,
            error_message,
            posted_at,
            approval_status = 'auto_posted'
        } = historyData;
        
        const sql = `
            INSERT INTO post_history 
            (facebook_account_id, group_id, post_content, image_paths, status, error_message, posted_at, approval_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `;
        
        // Ensure all params are strings or numbers
        const params = [
            String(facebook_account_id || ''),
            String(group_id || ''),
            String(post_content || ''),
            String(typeof image_paths === 'string' ? image_paths : JSON.stringify(image_paths || [])),
            String(status || 'success'),
            error_message ? String(error_message) : null,
            posted_at ? String(posted_at) : new Date().toISOString(),
            String(approval_status || 'auto_posted')
        ];
        
        const result = await query(sql, params);
        
        return result.insertId;
    }
    
    static async getAll(filters = {}, page = 1, limit = 50) {
        let sql = `
            SELECT ph.*, 
                fa.name as account_name,
                fg.group_name
            FROM post_history ph
            LEFT JOIN facebook_accounts fa ON ph.facebook_account_id = fa.id
            LEFT JOIN fb_groups fg ON ph.group_id = fg.id
            WHERE 1=1
        `;
        const params = [];
        
        if (filters.account_id) {
            sql += ` AND ph.facebook_account_id = ?`;
            params.push(filters.account_id);
        }
        
        if (filters.status) {
            sql += ` AND ph.status = ?`;
            params.push(filters.status);
        }
        
        if (filters.date_from) {
            sql += ` AND ph.posted_at >= ?`;
            params.push(filters.date_from);
        }
        
        if (filters.date_to) {
            sql += ` AND ph.posted_at <= ?`;
            params.push(filters.date_to);
        }
        
        if (filters.search) {
            sql += ` AND (ph.post_content LIKE ? OR fg.group_name LIKE ?)`;
            params.push(`%${filters.search}%`, `%${filters.search}%`);
        }
        
        // Get total count
        const countSql = sql.replace(/SELECT ph\.\*.*FROM/, 'SELECT COUNT(*) as total FROM');
        const countResult = await query(countSql, params);
        const total = countResult[0]?.total || 0;
        
        // Get paginated data
        sql += ` ORDER BY ph.posted_at DESC LIMIT ? OFFSET ?`;
        params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
        
        const rows = await query(sql, params);
        
        return {
            data: rows,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                totalPages: Math.ceil(total / limit)
            }
        };
    }
    
    static async getStats(accountId = null) {
        let sql = `
            SELECT 
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
                SUM(CASE WHEN date(posted_at) = date('now') THEN 1 ELSE 0 END) as today,
                SUM(CASE WHEN posted_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as this_week,
                SUM(CASE WHEN posted_at >= date('now', '-30 days') THEN 1 ELSE 0 END) as this_month
            FROM post_history
            WHERE 1=1
        `;
        const params = [];
        
        if (accountId) {
            sql += ` AND facebook_account_id = ?`;
            params.push(accountId);
        }
        
        const results = await query(sql, params);
        return results[0];
    }
    
    static async getDailyStats(days = 30, accountId = null) {
        let sql = `
            SELECT 
                date(posted_at) as date,
                COUNT(*) as total,
                SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
            FROM post_history
            WHERE posted_at >= datetime('now', '-' || ? || ' days')
        `;
        const params = [`-${days}`];
        
        if (accountId) {
            sql += ` AND facebook_account_id = ?`;
            params.push(accountId);
        }
        
        sql += ` GROUP BY date(posted_at) ORDER BY date DESC`;
        
        return await query(sql, params);
    }
    
    static async deleteOld(days = 90) {
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - days);
        const sql = `DELETE FROM post_history WHERE posted_at < datetime(?)`;
        const result = await query(sql, [cutoffDate.toISOString()]);
        return result.affectedRows;
    }

    static async deleteAll() {
        const result = await query('DELETE FROM post_history');
        return result.affectedRows;
    }
}

module.exports = PostHistory;
