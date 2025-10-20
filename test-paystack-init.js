require('dotenv').config();
const { initializeTransaction } = require('./helpers/paystack');

(async () => {
  try {
    const init = await initializeTransaction({
      email: 'test@example.com',
      amountKobo: 1000, // ₦10.00
      reference: 'xtt_local_' + Date.now(),
      callback_url: process.env.FRONTEND_CALLBACK_URL
    });
    console.log('init.data:', init.data);
    console.log('Open this URL to complete payment:', init.data.authorization_url);
    console.log('Reference to use for verify:', init.data.reference);
  } catch (e) {
    console.error('init error', e.message, e.raw || '');
  }
})();
