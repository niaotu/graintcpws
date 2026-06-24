import { build } from 'esbuild';

build({
  entryPoints: ['src/_worker.js'],
  bundle: true,
  minify: true,
  outdir: 'dist',
  format: 'esm',
  target: 'es2022',
  external: ['cloudflare:sockets']
}).catch(() => process.exit(1));
