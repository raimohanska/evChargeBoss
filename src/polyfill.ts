// Polyfill global fetch for Node.js < 18.
// Injected by esbuild at build time; not used during development.
import nodeFetch from 'node-fetch';
const g = globalThis as Record<string, unknown>;
if (!g['fetch']) g['fetch'] = nodeFetch;
