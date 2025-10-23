// models/GeneralTable.js
const { getPool } = require('../config/db');

/**
 * Safely escape identifier for use in queries.
 * Allows letters, numbers and underscore only.
 */
function escapeId(name) {
  if (!name || typeof name !== 'string') throw new Error('Invalid identifier');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error('Invalid identifier characters');
  return '`' + name + '`';
}

/**
 * Verify that a table exists in the current database.
 * Throws if invalid name or not found.
 */
async function ensureTableExists(table) {
  if (!table || typeof table !== 'string' || !/^[A-Za-z0-9_]+$/.test(table)) {
    throw new Error('Invalid table name');
  }
  const db = await getPool();
  const [rows] = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
    [table]
  );
  if (!rows || rows.length === 0) throw new Error(`Table not found: ${table}`);
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
    await ensureTableExists(table);
    const db = await getPool();
    const [cols] = await db.query(
      `SELECT column_name, column_type, data_type, is_nullable, column_key, extra, ordinal_position
       FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ?
       ORDER BY ordinal_position`,
      [table]
    );
    return cols.map(c => ({
      name: c.COLUMN_NAME || c.column_name,
      column_type: c.COLUMN_TYPE || c.column_type,
      data_type: c.DATA_TYPE || c.data_type,
      is_nullable: c.IS_NULLABLE || c.is_nullable,
      column_key: c.COLUMN_KEY || c.column_key,
      extra: c.EXTRA || c.extra,
      ordinal_position: c.ORDINAL_POSITION || c.ordinal_position
    }));
  }

  // get the first primary key column name, or null
  static async getPrimaryKey(table) {
    await ensureTableExists(table);
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
    return pkRows.length ? pkRows[0].COLUMN_NAME || pkRows[0].column_name : null;
  }

  // list rows with optional simple where object, limit, offset
  // returns an object { rows, columns, primaryKey }
  static async listRows(table, { limit = 50, offset = 0, where = null } = {}) {
    await ensureTableExists(table);

    limit = Math.min(1000, Number(limit) || 50);
    offset = Math.max(0, Number(offset) || 0);
    const db = await getPool();

    // Build WHERE safely if provided
    const params = [];
    let whereSql = '';
    if (where && typeof where === 'object' && Object.keys(where).length) {
      const parts = [];
      for (const k of Object.keys(where)) {
        if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error('Invalid where column');
        parts.push(`${escapeId(k)} = ?`);
        params.push(where[k]);
      }
      if (parts.length) whereSql = ' WHERE ' + parts.join(' AND ');
    }

    // Use backticks for table name and avoid relying on ORDER BY 1 alone:
    // attempt to order by primary key if available, otherwise fall back to created_at or 1
    const pk = await this.getPrimaryKey(table);
    let orderBy = 'ORDER BY 1';
    if (pk) orderBy = `ORDER BY ${escapeId(pk)} DESC`;
    else {
      // try a common timestamp column
      const cols = await this.getColumns(table);
      const ts = cols.find(c => /created_at|createdAt|createdAt/i.test(c.name));
      if (ts) orderBy = `ORDER BY ${escapeId(ts.name)} DESC`;
    }

    const sql = `SELECT * FROM ${escapeId(table)} ${whereSql} ${orderBy} LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const [rows] = await db.query(sql, params);
    const columns = await this.getColumns(table).catch(() => []);
    return { rows, columns, primaryKey: pk };
  }

  // get single row by primary key column
  static async getRow(table, pkColumn, pkValue) {
    await ensureTableExists(table);
    if (!pkColumn || !/^[A-Za-z0-9_]+$/.test(pkColumn)) throw new Error('Invalid primary key column');
    const db = await getPool();
    const sql = `SELECT * FROM ${escapeId(table)} WHERE ${escapeId(pkColumn)} = ? LIMIT 1`;
    const [rows] = await db.query(sql, [pkValue]);
    return rows[0] || null;
  }

  // update row by pk (fields is object); returns affectedRows
  static async updateRow(table, pkColumn, pkValue, fields) {
    await ensureTableExists(table);
    const keys = Object.keys(fields || {});
    if (!keys.length) return 0;
    // prevent updating pk column
    const filteredKeys = keys.filter(k => k !== pkColumn);
    if (!filteredKeys.length) return 0;
    for (const k of filteredKeys) {
      if (!/^[A-Za-z0-9_]+$/.test(k)) throw new Error('Invalid field name');
    }
    const db = await getPool();
    const set = filteredKeys.map(k => `${escapeId(k)} = ?`).join(', ');
    const params = filteredKeys.map(k => fields[k]);
    params.push(pkValue);
    const sql = `UPDATE ${escapeId(table)} SET ${set} WHERE ${escapeId(pkColumn)} = ?`;
    const [res] = await db.query(sql, params);
    return res.affectedRows;
  }

  // delete row by pk
  static async deleteRow(table, pkColumn, pkValue) {
    await ensureTableExists(table);
    if (!pkColumn || !/^[A-Za-z0-9_]+$/.test(pkColumn)) throw new Error('Invalid primary key column');
    const db = await getPool();
    const sql = `DELETE FROM ${escapeId(table)} WHERE ${escapeId(pkColumn)} = ?`;
    const [res] = await db.query(sql, [pkValue]);
    return res.affectedRows;
  }
}

module.exports = GeneralTable;
