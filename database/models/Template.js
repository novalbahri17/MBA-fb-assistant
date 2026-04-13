const { query } = require('../connection');

class Template {
    static async create(templateData) {
        const {
            facebook_account_id,
            name,
            post_type,
            content,
            link_url,
            image_paths,
            category = 'general'
        } = templateData;
        
        const sql = `
            INSERT INTO post_templates 
            (facebook_account_id, name, post_type, content, link_url, image_paths, category)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `;
        
        const result = await query(sql, [
            facebook_account_id,
            name,
            post_type,
            content,
            link_url,
            JSON.stringify(image_paths || []),
            category
        ]);
        
        return result.insertId;
    }
    
    static async getAll(filters = {}) {
        let sql = `
            SELECT t.*, fa.name as account_name 
            FROM post_templates t
            LEFT JOIN facebook_accounts fa ON t.facebook_account_id = fa.id
            WHERE 1=1
        `;
        const params = [];
        
        if (filters.account_id) {
            sql += ` AND (t.facebook_account_id = ? OR t.facebook_account_id IS NULL)`;
            params.push(filters.account_id);
        }
        
        if (filters.category) {
            sql += ` AND t.category = ?`;
            params.push(filters.category);
        }
        
        if (filters.post_type) {
            sql += ` AND t.post_type = ?`;
            params.push(filters.post_type);
        }
        
        sql += ` ORDER BY t.use_count DESC, t.created_at DESC`;
        
        return await query(sql, params);
    }
    
    static async getById(id) {
        const sql = `
            SELECT t.*, fa.name as account_name 
            FROM post_templates t
            LEFT JOIN facebook_accounts fa ON t.facebook_account_id = fa.id
            WHERE t.id = ?
        `;
        const results = await query(sql, [id]);
        return results[0] || null;
    }
    
    static async update(id, updateData) {
        const allowedFields = ['name', 'post_type', 'content', 'link_url', 'image_paths', 'category'];
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
        const sql = `UPDATE post_templates SET ${fields.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`;
        const result = await query(sql, values);
        return result.affectedRows > 0;
    }
    
    static async incrementUseCount(id) {
        const sql = `UPDATE post_templates SET use_count = use_count + 1, last_used = CURRENT_TIMESTAMP WHERE id = ?`;
        await query(sql, [id]);
    }
    
    static async delete(id) {
        const result = await query(`DELETE FROM post_templates WHERE id = ?`, [id]);
        return result.affectedRows > 0;
    }
    
    static async getCategories() {
        const sql = `SELECT DISTINCT category FROM post_templates ORDER BY category`;
        const results = await query(sql);
        return results.map(r => r.category);
    }
}

module.exports = Template;
