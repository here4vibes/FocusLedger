// Test the create-link-token endpoint
const https = require('https');

async function test() {
  // Step 1: Login
  const loginData = JSON.stringify({ email: 'qa@focusledger.net', password: 'QA_Test_2026!FocusLedger' });
  const loginReq = https.request({
    hostname: 'focusledger.polsia.app',
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginData) }
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      const data = JSON.parse(body);
      const token = data.token || data.fl_token;
      if (!token) {
        console.log('No token from login. Status:', res.statusCode);
        console.log('Response:', JSON.stringify(data).substring(0, 300));
        return;
      }
      console.log('Got token (first 20 chars):', token.substring(0, 20));

      // Step 2: Hit create-link-token
      const req2 = https.request({
        hostname: 'focusledger.polsia.app',
        path: '/api/plaid/create-link-token',
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
      }, (res2) => {
        let body2 = '';
        res2.on('data', d => body2 += d);
        res2.on('end', () => {
          console.log('create-link-token status:', res2.statusCode);
          console.log('create-link-token response:', body2.substring(0, 2000));
        });
      });
      req2.on('error', e => console.error('Request error:', e.message));
      req2.end();
    });
  });
  loginReq.on('error', e => console.error('Login error:', e.message));
  loginReq.write(loginData);
  loginReq.end();
}

test().catch(e => console.error('Test failed:', e.message));