import httpProxy from 'http-proxy';
import http from 'http';

const proxy = httpProxy.createProxyServer({});

const server = http.createServer((req, res) => {
  const parts = req.url.split('/');
  if (parts[1] === 'moonraker') {
    const targetHost = parts[2];
    req.url = '/' + parts.slice(3).join('/');
    proxy.web(req, res, { target: 'http://' + targetHost, changeOrigin: true });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(8082, () => console.log('Proxy running on 8082'));
