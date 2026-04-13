const { query } = require('../connection');

class Account {
    static async create(accountData) {
        const { name, facebook_id, email, access_token, cookies_json, profile_picture } = accountData;
        const sql = `
            INSERT INTO facebook_accounts 
            (name, facebook_id, email, access_token, cookies_json, profile_picture, last_used)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `;
        // Convert undefined to null
        const values = [
            name || null,
            facebook_id || null,
            email || null,
            access_token || null,
            typeof cookies_json === 'object' ? JSON.stringify(cookies_json) : cookies_json || null,
            profile_picture || null
        ];
        const result = await query(sql, values);
        return result.insertId;
    }
    
    static async getAll() {
        console.log('Account.getAll called');
        try {
            const result = await query(`SELECT * FROM facebook_accounts ORDER BY created_at DESC`);
            console.log('Account.getAll result:', result?.length || 0, 'rows');
            return result;
        } catch (error) {
            console.error('Error in Account.getAll:', error);
            throw error;
        }
    }
    
    static async getActive() {
        return await query(`SELECT * FROM facebook_accounts WHERE status = 'active' ORDER BY last_used DESC`);
    }
    
    static async getById(id) {
        const results = await query(`SELECT * FROM facebook_accounts WHERE id = ?`, [id]);
        return results[0] || null;
    }
    
    static async update(id, updateData) {
        const allowedFields = ['name', 'facebook_id', 'email', 'access_token', 'cookies_json', 'profile_picture', 'status'];
        const fields = [];
        const values = [];
        
        for (const [key, value] of Object.entries(updateData)) {
            if (allowedFields.includes(key)) {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        
        if (fields.length === 0) return false;
        
        values.push(id);
        const sql = `UPDATE facebook_accounts SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }
    
    static async updateLastUsed(id) {
        await query(`UPDATE facebook_accounts SET last_used = datetime('now') WHERE id = ?`, [id]);
    }
    
    static async delete(id) {
        const result = await query(`DELETE FROM facebook_accounts WHERE id = ?`, [id]);
        return result.affectedRows > 0;
    }
    
    static async getStats(accountId) {
        const sql = `
            SELECT 
                (SELECT COUNT(*) FROM post_history WHERE facebook_account_id = ? AND status = 'success') as total_success,
                (SELECT COUNT(*) FROM post_history WHERE facebook_account_id = ? AND status = 'failed') as total_failed,
                (SELECT COUNT(*) FROM scheduled_posts WHERE facebook_account_id = ? AND status = 'scheduled') as scheduled_count,
                (SELECT COUNT(*) FROM fb_groups WHERE facebook_account_id = ?) as total_groups
        `;
        const results = await query(sql, [accountId, accountId, accountId, accountId]);
        return results[0];
    }
}

module.exports = Account;
