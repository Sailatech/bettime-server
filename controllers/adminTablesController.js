// controllers/adminTablesController.js
const GeneralTable = require('../models/GeneralTable');

async function listTables(req, res) {
  try {
    const tables = await GeneralTable.listTables();
    return res.json({ tables });
  } catch (err) {
    console.error('[adminTables] listTables', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function getTableColumns(req, res) {
  try {
    const table = req.params.table;
    const columns = await GeneralTable.getColumns(table);
    const pk = await GeneralTable.getPrimaryKey(table);
    return res.json({ columns, primaryKey: pk });
  } catch (err) {
    console.error('[adminTables] getTableColumns', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function listRows(req, res) {
  try {
    const table = req.params.table;
    const limit = req.query.limit;
    const offset = req.query.offset;
    // optional simple filters via query param `filter` as JSON string
    let where = null;
    if (req.query.filter) {
      try {
        where = JSON.parse(req.query.filter);
      } catch (e) {
        return res.status(400).json({ error: 'invalid filter JSON' });
      }
    }
    const rows = await GeneralTable.listRows(table, { limit, offset, where });
    const pk = await GeneralTable.getPrimaryKey(table);
    return res.json({ primaryKey: pk, rows });
  } catch (err) {
    console.error('[adminTables] listRows', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function getRow(req, res) {
  try {
    const table = req.params.table;
    const id = req.params.id;
    const pk = await GeneralTable.getPrimaryKey(table);
    if (!pk) return res.status(400).json({ error: 'primary key not found' });
    const row = await GeneralTable.getRow(table, pk, id);
    return res.json(row);
  } catch (err) {
    console.error('[adminTables] getRow', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
  }
}

async function updateRow(req, res) {
  try {
    const table = req.params.table;
    const id = req.params.id;
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
    return res.status(500).json({ error: 'server error' });
  }
}

async function deleteRow(req, res) {
  try {
    const table = req.params.table;
    const id = req.params.id;
    const pk = await GeneralTable.getPrimaryKey(table);
    if (!pk) return res.status(400).json({ error: 'primary key not found' });
    const affected = await GeneralTable.deleteRow(table, pk, id);
    return res.json({ affectedRows: affected });
  } catch (err) {
    console.error('[adminTables] deleteRow', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'server error' });
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
