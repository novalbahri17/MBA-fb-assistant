const { query } = require('../connection');

class ScheduledPost {
    static async create(postData) {
        const {
            facebook_account_id,
            post_type,
            content,
            link_url,
            image_paths,
            target_type,
            target_ids,
            schedule_time,
            timezone = 'Asia/Jakarta'
        } = postData;
        
        const sql = `
            INSERT INTO scheduled_posts 
            (facebook_account_id, post_type, content, link_url, image_paths, target_type, target_ids, schedule_time, timezone, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')
        `;
        
        const result = await query(sql, [
            facebook_account_id,
            post_type,
            content,
            link_url,
            JSON.stringify(image_paths || []),
            target_type,
            JSON.stringify(target_ids || []),
            schedule_time,
            timezone
        ]);
        
        return result.insertId;
    }
    
    static async getAll(filters = {}) {
        console.log('ScheduledPost.getAll called with filters:', filters);
        
        let sql = `
            SELECT sp.*, fa.name as account_name, fa.profile_picture 
            FROM scheduled_posts sp
            JOIN facebook_accounts fa ON sp.facebook_account_id = fa.id
            WHERE 1=1
        `;
        const params = [];
        
        if (filters.status) {
            sql += ` AND sp.status = ?`;
            params.push(filters.status);
        }
        
        if (filters.account_id) {
            sql += ` AND sp.facebook_account_id = ?`;
            params.push(filters.account_id);
        }
        
        sql += ` ORDER BY sp.schedule_time DESC`;
        
        console.log('SQL query:', sql);
        console.log('SQL params:', params);
        
        try {
            const result = await query(sql, params);
            console.log('Query result:', result?.length || 0, 'rows');
            return result;
        } catch (error) {
            console.error('Error in ScheduledPost.getAll:', error);
            throw error;
        }
    }
    
    static async getPending() {
        const sql = `
            SELECT sp.*, fa.name as account_name, fa.cookies_json
            FROM scheduled_posts sp
            JOIN facebook_accounts fa ON sp.facebook_account_id = fa.id
            WHERE sp.status = 'scheduled' 
            AND sp.schedule_time <= datetime('now', '+1 minute')
            ORDER BY sp.schedule_time ASC
        `;
        return await query(sql);
    }
    
    static async getById(id) {
        const sql = `
            SELECT sp.*, fa.name as account_name 
            FROM scheduled_posts sp
            JOIN facebook_accounts fa ON sp.facebook_account_id = fa.id
            WHERE sp.id = ?
        `;
        const results = await query(sql, [id]);
        return results[0] || null;
    }
    
    static async update(id, updateData) {
        const allowedFields = ['post_type', 'content', 'link_url', 'image_paths', 'target_type', 'target_ids', 'schedule_time', 'timezone', 'status', 'error_message', 'published_at', 'retry_count'];
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updateData)) {
            if (allowedFields.includes(key)) {
                fields.push(`${key} = ?`);
                values.push(typeof value === 'object' ? JSON.stringify(value) : value);
            }
        }
        
        if (fields.length === 0) return false;
        
        values.push(id);
        const sql = `UPDATE scheduled_posts SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }
    
    static async delete(id) {
        const result = await query(`DELETE FROM scheduled_posts WHERE id = ?`, [id]);
        return result.affectedRows > 0;
    }
    
    static async updateStatus(id, status, errorMessage = null) {
        const sql = `
            UPDATE scheduled_posts 
            SET status = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP
            ${status === 'published' ? ', published_at = CURRENT_TIMESTAMP' : ''}
            WHERE id = ?
        `;
        await query(sql, [status, errorMessage, id]);
    }
}

module.exports = ScheduledPost;
