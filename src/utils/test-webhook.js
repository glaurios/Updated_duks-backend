import crypto from 'crypto';
import https from 'https';

const SECRET_KEY = 'sk_test_226ad62709703eccaa934a88d9bffa8a0726c13d';
const WEBHOOK_URL = 'https://v67p2qfl-5000.uks1.devtunnels.ms/api/payments/webhook';

const payload = {
  event: "charge.success",
  data: {
    reference: "TEST_NODE_" + Date.now(),
    amount: 25000, // 240 GHS in pesewas
    metadata: {
      userId: "692a00b424a85d0390fb72ba",
      customer: {
        fullName: "Order Test",
        email: "kwarteon08@gmail.com",
        phone: "0551234568",
        address: "Test Address",
        city: "Accra",
        country: "Ghana"
      },
      items: [
        {
          drinkId: "691dfc510c9aa70ff11e0672",
          name: "Orange juice",
          price: 61,
          quantity: 4,
          pack: "500ml",
          image: ""
        }
      ],
      calculatedTotal: 250
    }
  }
};

const payloadString = JSON.stringify(payload);

// Generate signature
const signature = crypto
  .createHmac('sha512', SECRET_KEY)
  .update(payloadString)
  .digest('hex');

console.log('🔐 Signature:', signature.substring(0, 50) + '...');
console.log('📤 Sending webhook to:', WEBHOOK_URL);
console.log('📝 Reference:', payload.data.reference);
console.log('');

// Parse URL
const url = new URL(WEBHOOK_URL);

// Prepare request options
const options = {
  hostname: url.hostname,
  port: url.port || 443,
  path: url.pathname,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-paystack-signature': signature,
    'Content-Length': Buffer.byteLength(payloadString)
  }
};

// Send request
const req = https.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log('✅ Response Status:', res.statusCode);
    console.log('✅ Response:', data);
    console.log('');
    console.log('📧 Check your email for order confirmation!');
    console.log('🖥️  Check your server console for logs!');
  });
});

req.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

req.write(payloadString);
req.end();