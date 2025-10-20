// controllers/adminController.js
const adminBalance = require('../models/adminBalanceModel');;

async function getAdminDashboard(req, res) {
  try {
    const balance = await adminBalance.getAdminBalance();
    const rates = await chargeRatesModel.listChargeRates();
    return res.json({ adminBalance: balance, chargeRates: rates });
  } catch (err) {
    console.error('getAdminDashboard', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function upsertChargeRate(req, res) {
  try {
    const { minAmount, maxAmount, feeAmount } = req.body;
    if (minAmount == null || maxAmount == null || feeAmount == null) return res.status(400).json({ error: 'Missing fields' });
    const updated = await chargeRatesModel.upsertChargeRate(minAmount, maxAmount, feeAmount);
    await platformEvent.createEvent('charge_rate_updated', { minAmount, maxAmount, feeAmount });
    return res.json({ chargeRates: updated });
  } catch (err) {
    console.error('upsertChargeRate', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { getAdminDashboard, upsertChargeRate };
