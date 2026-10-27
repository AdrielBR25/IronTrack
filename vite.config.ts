import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// GitHub Pages serve o app em /IronTrack/. BASE_PATH permite outro subdiretório.
const base = process.env.BASE_PATH ?? '/IronTrack/';

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
        globIgnores: ['**/*cyrillic*', '**/*greek*', '**/*vietnamese*'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
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
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
