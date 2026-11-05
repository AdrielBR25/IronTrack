import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serve o app em /IronTrack/. BASE_PATH permite outro subdiretório (irontrack-web na Railway: "/").
const base = process.env.BASE_PATH ?? '/IronTrack/';

// P21: em desenvolvimento e nos testes E2E da nuvem, `/api` vai para a API local (mesma origem, como o Caddy do irontrack-web).
// Só lido aqui (Node), nunca vai para o bundle.
const apiProxy = process.env.API_PROXY_TARGET ? { '/api': { target: process.env.API_PROXY_TARGET, changeOrigin: false, xfwd: true } } : undefined;

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png', 'examples/*.json'],
      manifest: {
        name: 'IronTrack — Treinos de musculação',
        short_name: 'IronTrack',
        description: 'Registre treinos, descanso e evolução de carga. Funciona offline.',
        lang: 'pt-BR',
        theme_color: '#0b0d0c',
        background_color: '#0b0d0c',
        id: base,
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        categories: ['health', 'fitness', 'sports'],
        shortcuts: [{ name: 'Treino de hoje', short_name: 'Treinar', url: `${base}#/`, icons: [{ src: 'pwa-192.png', sizes: '192x192' }] }],
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,svg,png,woff2,json}'],
        // Fase 05: o texto bíblico (66 livros, ~4,7 MB) não entra no pré-cache: cada livro vai para o cache ao ser aberto
        // (ou todos em "Baixar para ler offline"), e daí em diante funciona sem conexão.
        globIgnores: ['**/*cyrillic*', '**/*greek*', '**/*vietnamese*', '**/assets/bible/**'],
        runtimeCaching: [{ urlPattern: /\/assets\/bible\/[^/]+\.json$/, handler: 'CacheFirst', options: { cacheName: 'irontrack-bible-bpm', expiration: { maxEntries: 80 } } }],
        navigateFallback: 'index.html',
        // P21: a API nunca é atendida pelo service worker (nem cache, nem página do app no lugar dela).
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  server: apiProxy ? { proxy: apiProxy } : {},
  preview: apiProxy ? { proxy: apiProxy } : {},
  build: {
    // Livros da Bíblia sempre como arquivo próprio (nunca embutidos no JS), para o cache por livro.
    assetsInlineLimit: (file) => (/shared[\\/]bible[\\/]data[\\/]/.test(file) ? false : undefined),
    rollupOptions: {
      output: {
        assetFileNames: (a) => (/\.json$/.test(a.names?.[0] ?? a.name ?? '') && /^[1-3A-Z]{3}\.json$/.test(a.names?.[0] ?? a.name ?? '') ? 'assets/bible/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'),
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          ui: ['framer-motion', '@radix-ui/react-dialog', '@radix-ui/react-switch', '@radix-ui/react-tabs', 'sonner'],
          data: ['dexie', 'dexie-react-hooks', 'zod'],
        },
      },
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)), '@shared': fileURLToPath(new URL('./shared', import.meta.url)) },
  },
});
