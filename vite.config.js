import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';

export default defineConfig({
  plugins: [
    dts({ insertTypesEntry: true })
  ],
  server: {
    open: '/test/index.html'
  },
  build: {
    sourcemap: true,
    lib: {
      entry: './src/index.ts',
      name: 'AnnotoriousSupabase',
      formats: ['es', 'umd'],
      fileName: 'annotorious-supabase'
    },
    rollupOptions: {
      output: {
        assetFileNames: 'annotorious-supabase.[ext]'
      }
    }
  }
});