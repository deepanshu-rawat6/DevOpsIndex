import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    build: {
      rollupOptions: {
        // pagefind assets are generated post-build — they don't exist at compile time
        external: [/\/pagefind\//],
      },
    },
  },
});
