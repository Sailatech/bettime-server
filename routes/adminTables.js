// routes/adminTables.js
const express = require('express');
const router = express.Router();
const adminTablesCtrl = require('../controllers/adminTablesController');
const auth = require('../middleware/auth');
const ensureAdmin = require('../middleware/ensureAdmin');

// protect all admin table routes
router.use(auth, ensureAdmin);

// GET  /admin/tables                 -> list tables
router.get('/', adminTablesCtrl.listTables);

// GET  /admin/tables/:table/columns -> get columns for :table
router.get('/:table/columns', adminTablesCtrl.getTableColumns);

// GET  /admin/tables/:table         -> list rows (supports ?limit=&offset=&filter=)
router.get('/:table', adminTablesCtrl.listRows);

// GET  /admin/tables/:table/:id     -> get single row by primary key
router.get('/:table/:id', adminTablesCtrl.getRow);

// PUT  /admin/tables/:table/:id     -> update row
router.put('/:table/:id', express.json(), adminTablesCtrl.updateRow);

// DELETE /admin/tables/:table/:id   -> delete row
router.delete('/:table/:id', adminTablesCtrl.deleteRow);

module.exports = router;
