// models/GeneralTable.js
const { getPool } = require('../config/db');

/**
 * Safely escape identifier for use in queries.
 * Only allows letters, numbers, _, and $ and dots are not allowed.
 */
function escapeId(name) {
  if (!name || typeof name !== 'string') throw new Error('Invalid identifier');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid identifier characters');
  return '`' + name + '`';
}

class GeneralTable {
  // list table names in the current database
  static async listTables() {
    const db = await getPool();
    const [rows] = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() ORDER BY table_name`
    );
    return rows.map(r => r.TABLE_NAME || r.table_name);
  }

  // get columns metadata for a table
  static async getColumns(table) {
    const db = await getPool();
    const [cols] = await db.query(
      `SELECT column_name, column_type, data_type, is_nullable, column_key, extra
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ordinal_position`,
      [table]
    );
    return cols;
  }

  // get the first primary key column name, or null
  static async getPrimaryKey(table) {
    const db = await getPool();
    const [pkRows] = await db.query(
      `SELECT column_name
       FROM information_schema.key_column_usage
       WHERE table_schema = DATABASE()
         AND table_name = ?
         AND constraint_name = 'PRIMARY'
       ORDER BY ordinal_position
       LIMIT 1`,
      [table]
    );
    return pkRows.length ? pkRows[0].COLUMN_NAME : null;
  }

  // list rows with optional simple where object, limit, offset
  static async listRows(table, { limit = 50, offset = 0, where = null } = {}) {
    limit = Math.min(1000, Number(limit) || 50);
    offset = Math.max(0, Number(offset) || 0);
    const db = await getPool();

    let sql = `SELECT * FROM ${escapeId(table)}`;
    const params = [];
    if (where && typeof where === 'object' && Object.keys(where).length) {
      const parts = [];
      for (const k of Object.keys(where)) {
        if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error('Invalid where column');
        parts.push(`${escapeId(k)} = ?`);
        params.push(where[k]);
      }
      sql += ' WHERE ' + parts.join(' AND ');
    }
    sql += ' ORDER BY 1 LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [rows] = await db.query(sql, params);
    return rows;
  }

  // get single row by primary key column
  static async getRow(table, pkColumn, pkValue) {
    const db = await getPool();
    const sql = `SELECT * FROM ${escapeId(table)} WHERE ${escapeId(pkColumn)} = ? LIMIT 1`;
    const [rows] = await db.query(sql, [pkValue]);
    return rows[0] || null;
  }

  // update row by pk (fields is object); returns affectedRows
  static async updateRow(table, pkColumn, pkValue, fields) {
    const keys = Object.keys(fields || {});
    if (!keys.length) return 0;
    for (const k of keys) {
      if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error('Invalid field name');
      if (k === pkColumn) delete fields[k];
    }
    const db = await getPool();
    const set = keys.map(k => `${escapeId(k)} = ?`).join(', ');
    const params = keys.map(k => fields[k]);
    params.push(pkValue);
    const sql = `UPDATE ${escapeId(table)} SET ${set} WHERE ${escapeId(pkColumn)} = ?`;
    const [res] = await db.query(sql, params);
    return res.affectedRows;
  }

  // delete row by pk
  static async deleteRow(table, pkColumn, pkValue) {
    const db = await getPool();
    const sql = `DELETE FROM ${escapeId(table)} WHERE ${escapeId(pkColumn)} = ?`;
    const [res] = await db.query(sql, [pkValue]);
    return res.affectedRows;
  }
}

module.exports = GeneralTable;
