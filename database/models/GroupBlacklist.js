const { query } = require("../connection");

/**
 * Daftar hitam grup: grup yang tidak bisa diposting (mis. "Post box tidak ditemukan").
 * Grup blacklist dihapus dari fb_groups (Manajemen Grup) dan tidak dimasukkan
 * lagi saat scan berikutnya.
 */
class GroupBlacklist {
  static async getAll(filters = {}) {
    try {
      let sql = "SELECT * FROM group_blacklist WHERE 1=1";
      const params = [];

      if (filters.account_id !== undefined && filters.account_id !== null) {
        sql += " AND facebook_account_id = ?";
        params.push(filters.account_id);
      }

      sql += " ORDER BY created_at DESC";
      return await query(sql, params);
    } catch (error) {
      console.error("GroupBlacklist.getAll error:", error);
      throw error;
    }
  }

  static async getGroupIds(accountId = null) {
    const rows = await this.getAll(
      accountId === undefined || accountId === null ? {} : { account_id: accountId },
    );
    return rows.map((r) => String(r.group_id));
  }

  static async isBlacklisted(groupId, accountId = null) {
    try {
      let sql = "SELECT id FROM group_blacklist WHERE group_id = ?";
      const params = [String(groupId)];

      if (accountId !== undefined && accountId !== null) {
        sql += " AND (facebook_account_id = ? OR facebook_account_id IS NULL)";
        params.push(accountId);
      }

      const rows = await query(sql, params);
      return rows.length > 0;
    } catch (error) {
      console.error("GroupBlacklist.isBlacklisted error:", error);
      return false;
    }
  }

  static async add(groupId, options = {}) {
    try {
      const {
        accountId = null,
        groupName = null,
        reason = "Post box tidak ditemukan di halaman utama",
      } = options;

      const gid = String(groupId);

      // Hapus entri lama dulu agar tidak duplikat (SQLite menganggap NULL unik).
      await query(
        "DELETE FROM group_blacklist WHERE group_id = ? AND (facebook_account_id = ? OR (facebook_account_id IS NULL AND ? IS NULL))",
        [gid, accountId, accountId],
      );

      await query(
        `INSERT INTO group_blacklist
            (facebook_account_id, group_id, group_name, reason)
         VALUES (?, ?, ?, ?)`,
        [accountId, gid, groupName, reason],
      );
      return true;
    } catch (error) {
      console.error("GroupBlacklist.add error:", error);
      throw error;
    }
  }

  static async remove(groupId, accountId = null) {
    try {
      let sql = "DELETE FROM group_blacklist WHERE group_id = ?";
      const params = [String(groupId)];

      if (accountId !== undefined && accountId !== null) {
        sql += " AND facebook_account_id = ?";
        params.push(accountId);
      }

      const result = await query(sql, params);
      return result.affectedRows > 0;
    } catch (error) {
      console.error("GroupBlacklist.remove error:", error);
      throw error;
    }
  }

  static async removeAll() {
    const result = await query("DELETE FROM group_blacklist", []);
    return result.affectedRows > 0;
  }
}

module.exports = GroupBlacklist;
