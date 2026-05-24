import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GH Pages serves at /hospitaldash/ (repo name)
const base = process.env.GITHUB_PAGES === 'true' ? '/hospitaldash/' : '/';

export default defineConfig({
  base,
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
