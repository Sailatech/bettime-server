// controllers/adminTablesController.js
const GeneralTable = require('../models/GeneralTable');

/**
 * List available tables
 * GET /admin/tables
 */
async function listTables(req, res) {
  try {
    const tables = await GeneralTable.listTables();
    return res.json({ tables });
  } catch (err) {
    console.error('[adminTables] listTables', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

/**
 * Get columns and primary key for a table
 * GET /admin/tables/:table/columns
 */
async function getTableColumns(req, res) {
  try {
    const table = String(req.params.table || '').trim();
    if (!table) return res.status(400).json({ error: 'table parameter required' });

    const columns = await GeneralTable.getColumns(table);
    const pk = await GeneralTable.getPrimaryKey(table);
    return res.json({ columns, primaryKey: pk });
  } catch (err) {
    console.error('[adminTables] getTableColumns', err && err.stack ? err.stack : err);
    const msg = err && err.message ? err.message : 'server error';
    return res.status(msg.startsWith('Table not found') || msg.includes('Invalid') ? 400 : 500).json({ error: msg });
  }
}

/**
 * List rows for a table with optional filter, limit, offset
 * GET /admin/tables/:table?limit=&offset=&filter=
 */
async function listRows(req, res) {
  try {
    const table = String(req.params.table || '').trim();
    if (!table) return res.status(400).json({ error: 'table parameter required' });

    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    const offset = req.query.offset ? Number(req.query.offset) : undefined;

    let where = null;
    if (req.query.filter) {
      try {
        where = JSON.parse(req.query.filter);
      } catch (e) {
        return res.status(400).json({ error: 'invalid filter JSON' });
      }
    }

    const result = await GeneralTable.listRows(table, { limit, offset, where });
    // result is { rows, columns, primaryKey } per model
    return res.json(result);
  } catch (err) {
    console.error('[adminTables] listRows', err && err.stack ? err.stack : err);
    const msg = err && err.message ? err.message : 'server error';
    return res.status(msg.startsWith('Table not found') || msg.includes('Invalid') ? 400 : 500).json({ error: msg });
  }
}

/**
 * Get single row by primary key
 * GET /admin/tables/:table/:id
 */
async function getRow(req, res) {
  try {
    const table = String(req.params.table || '').trim();
    const id = req.params.id;
    if (!table) return res.status(400).json({ error: 'table parameter required' });
    if (typeof id === 'undefined') return res.status(400).json({ error: 'id required' });

    const pk = await GeneralTable.getPrimaryKey(table);
    if (!pk) return res.status(400).json({ error: 'primary key not found' });

    const row = await GeneralTable.getRow(table, pk, id);
    if (!row) return res.status(404).json({ error: 'row not found' });
    return res.json(row);
  } catch (err) {
    console.error('[adminTables] getRow', err && err.stack ? err.stack : err);
    const msg = err && err.message ? err.message : 'server error';
    return res.status(msg.startsWith('Table not found') || msg.includes('Invalid') ? 400 : 500).json({ error: msg });
  }
}

/**
 * Update a row by primary key
 * PUT /admin/tables/:table/:id
 */
async function updateRow(req, res) {
  try {
    const table = String(req.params.table || '').trim();
    const id = req.params.id;
    if (!table) return res.status(400).json({ error: 'table parameter required' });
    if (typeof id === 'undefined') return res.status(400).json({ error: 'id required' });

    const pk = await GeneralTable.getPrimaryKey(table);
    if (!pk) return res.status(400).json({ error: 'primary key not found' });

    const fields = req.body;
    if (!fields || typeof fields !== 'object') return res.status(400).json({ error: 'invalid body' });

    // strip protected columns
    delete fields.id;
    delete fields.created_at;
    delete fields.updated_at;

    const affected = await GeneralTable.updateRow(table, pk, id, fields);
    return res.json({ affectedRows: affected });
  } catch (err) {
    console.error('[adminTables] updateRow', err && err.stack ? err.stack : err);
    const msg = err && err.message ? err.message : 'server error';
    return res.status(msg.startsWith('Table not found') || msg.includes('Invalid') ? 400 : 500).json({ error: msg });
  }
}

/**
 * Delete a row by primary key
 * DELETE /admin/tables/:table/:id
 */
async function deleteRow(req, res) {
  try {
    const table = String(req.params.table || '').trim();
    const id = req.params.id;
    if (!table) return res.status(400).json({ error: 'table parameter required' });
    if (typeof id === 'undefined') return res.status(400).json({ error: 'id required' });

    const pk = await GeneralTable.getPrimaryKey(table);
    if (!pk) return res.status(400).json({ error: 'primary key not found' });

    const affected = await GeneralTable.deleteRow(table, pk, id);
    return res.json({ affectedRows: affected });
  } catch (err) {
    console.error('[adminTables] deleteRow', err && err.stack ? err.stack : err);
    const msg = err && err.message ? err.message : 'server error';
    return res.status(msg.startsWith('Table not found') || msg.includes('Invalid') ? 400 : 500).json({ error: msg });
  }
}

module.exports = {
  listTables,
  getTableColumns,
  listRows,
  getRow,
  updateRow,
  deleteRow
};
