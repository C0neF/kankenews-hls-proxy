const http = require('node:http');

const port = process.env.PORT || 3000;

const req = http.get(`http://127.0.0.1:${port}/status`, (res) => {
  let body = '';
  res.setEncoding('utf8');
  res.on('data', (chunk) => { body += chunk; });
  res.on('end', () => {
    try {
      const status = JSON.parse(body);
      process.exit(res.statusCode === 200 && status.hasUrl ? 0 : 1);
    } catch {
      process.exit(1);
    }
  });
});

req.setTimeout(5000, () => {
  req.destroy();
  process.exit(1);
});

req.on('error', () => process.exit(1));
