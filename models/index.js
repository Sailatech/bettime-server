// models/index.js
const { getPool } = require('../config/db');

async function pool() {
  return (await getPool());
}

module.exports = {
  pool,
  User: require('./userModel'),
  Match: require('./matchModel'),
  Bet: require('./betModel'),
  Move: require('./moveModel'),
  AdminBalance: require('./adminBalanceModel'),
  ChargeRates: require('./chargeRatesModel'),
  BalanceTransaction: require('./balanceTransactionModel'),
  Withdrawal: require('./withdrawalModel'),
  PlatformEvent: require('./platformEventModel'),
};
