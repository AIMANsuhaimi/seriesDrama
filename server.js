const http = require('http');
const handler = require('./api/index');

const server = http.createServer((req, res) => {
  handler(req, res);
});

const PORT = process.env.PORT || 7000;
server.listen(PORT, () => {
  console.log(`Addon local server running at http://127.0.0.1:${PORT}/manifest.json`);
});
