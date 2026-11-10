import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig, type Plugin } from 'vite';

// `npm run dev` serves on localhost (webcams work there).
// `npm run dev:lan` serves over HTTPS on the local network, which a headset
// (WebXR) and phones (extra cameras) need.
const lan = !!process.env.SCAFFOLD_LAN;

/** Dev only: /lan-info → this server's LAN addresses, so the phone QR code works when the page is opened on localhost. */
function lanInfo(): Plugin {
  return {
    name: 'scaffold-lan-info',
    configureServer(server) {
      server.middlewares.use('/lan-info', (_req, res) => {
        const address = server.httpServer?.address();
        const port = address && typeof address === 'object' ? address.port : server.config.server.port;
        const protocol = server.config.server.https ? 'https' : 'http';
        const urls = Object.values(networkInterfaces())
          .flat()
          .filter((a) => a && a.family === 'IPv4' && !a.internal)
          .map((a) => `${protocol}://${a!.address}:${port}`);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ urls }));
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [lanInfo(), ...(lan ? [basicSsl()] : [])],
  server: { host: lan ? true : undefined },
  build: {
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        phone: fileURLToPath(new URL('phone.html', import.meta.url)),
      },
    },
  },
});
