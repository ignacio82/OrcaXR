import { createServer } from 'vite';

async function run() {
  const server = await createServer({
    configFile: false,
    server: {
      port: 8083,
      proxy: {
        '^/moonraker/.*': {
          target: 'http://localhost',
          changeOrigin: true,
          router: (req) => {
            const parts = req.url.split('/');
            const target = parts[2];
            console.log("Routing to:", target);
            return `http://${target}`;
          },
          rewrite: (path) => {
            const parts = path.split('/');
            return '/' + parts.slice(3).join('/');
          },
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
              proxyReq.removeHeader('origin');
              console.log("Proxying to:", proxyReq.path);
            });
          }
        }
      }
    }
  });
  await server.listen();
  console.log("Listening on 8083");
}
run();
