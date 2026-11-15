import { defineConfig } from 'vite';

// Relative asset paths, so the built site works from any folder,
// including a GitHub Pages project address like user.github.io/neurolap/.
export default defineConfig({
  base: './',
});
