const { query } = require("../connection");

class Group {
  static async getAll(filters = {}) {
    try {
      let sql = "SELECT * FROM fb_groups WHERE 1=1";
      const params = [];

      if (filters.account_id) {
        sql += " AND facebook_account_id = ?";
        params.push(filters.account_id);
      }

      if (filters.status) {
        sql += " AND status = ?";
        params.push(filters.status);
      }

      if (filters.is_joined !== undefined) {
        sql += " AND is_joined = ?";
        params.push(filters.is_joined ? 1 : 0);
      }

      if (filters.group_id) {
        sql += " AND group_id = ?";
        params.push(filters.group_id);
      }

      sql += " ORDER BY group_name ASC";

      return await query(sql, params);
    } catch (error) {
      console.error("Group.getAll error:", error);
      throw error;
    }
  }

  static async getById(id) {
    try {
      const results = await query("SELECT * FROM fb_groups WHERE id = ?", [id]);
      return results[0] || null;
    } catch (error) {
      console.error("Group.getById error:", error);
      throw error;
    }
  }

  static async getByGroupId(groupId, accountId) {
    try {
      const results = await query(
        "SELECT * FROM fb_groups WHERE group_id = ? AND facebook_account_id = ?",
        [groupId, accountId],
      );
      return results[0] || null;
    } catch (error) {
      console.error("Group.getByGroupId error:", error);
      throw error;
    }
  }

  static async save(groupData) {
    try {
      const {
        facebook_account_id,
        group_id,
        group_name,
        group_type = "public",
        member_count = 0,
        category = null,
        is_joined = true,
        status = "active",
      } = groupData;

      // Check if group already exists
      const existing = await this.getByGroupId(group_id, facebook_account_id);

      if (existing) {
        // Update existing
        const result = await query(
          `UPDATE fb_groups SET
                        group_name = ?,
                        group_type = ?,
                        member_count = ?,
                        category = ?,
                        is_joined = ?,
                        status = ?,
                        updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
          [
            group_name,
            group_type,
            member_count,
            category,
            is_joined ? 1 : 0,
            status,
            existing.id,
          ],
        );
        return { id: existing.id, ...groupData, updated: true };
      } else {
        // Insert new
        const result = await query(
          `INSERT INTO fb_groups
                        (facebook_account_id, group_id, group_name, group_type, member_count, category, is_joined, status)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            facebook_account_id,
            group_id,
            group_name,
            group_type,
            member_count,
            category,
            is_joined ? 1 : 0,
            status,
          ],
        );
        return { id: result.insertId, ...groupData, inserted: true };
      }
    } catch (error) {
      console.error("Group.save error:", error);
      throw error;
    }
  }

  static async delete(id) {
    try {
      const result = await query("DELETE FROM fb_groups WHERE id = ?", [id]);
      return result.affectedRows > 0;
    } catch (error) {
      console.error("Group.delete error:", error);
      throw error;
    }
  }

  static async updateLastPosted(groupId) {
    try {
      await query(
        "UPDATE fb_groups SET last_posted = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [groupId],
      );
      return true;
    } catch (error) {
      console.error("Group.updateLastPosted error:", error);
      throw error;
    }
  }

  static async getStats(accountId) {
    try {
      const stats = {
        total: 0,
        active: 0,
        pending: 0,
        blocked: 0,
        posted: 0,
        notPosted: 0
      };

      let sql = "SELECT status, COUNT(*) as count FROM fb_groups WHERE facebook_account_id = ? GROUP BY status";
      const results = await query(sql, [accountId]);

      results.forEach(row => {
        if (row.status === 'active') stats.active = row.count;
        else if (row.status === 'pending') stats.pending = row.count;
        else if (row.status === 'blocked') stats.blocked = row.count;
      });

      stats.total = stats.active + stats.pending + stats.blocked;

      const postedResult = await query(
        "SELECT COUNT(*) as count FROM fb_groups WHERE facebook_account_id = ? AND last_posted IS NOT NULL",
        [accountId]
      );
      stats.posted = postedResult[0]?.count || 0;
      stats.notPosted = stats.total - stats.posted;

      return stats;
    } catch (error) {
      console.error("Group.getStats error:", error);
      throw error;
    }
  }
}

module.exports = Group;
