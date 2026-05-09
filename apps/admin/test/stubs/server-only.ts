// Stub for the Next.js `server-only` virtual module.
// Next emits this at build time to fail builds that import server-side
// modules from client components. Under vitest the import simply
// resolves to this empty file. The runtime fence stays active in
// `next build` — see apps/admin/vitest.config.ts for the alias wiring.
export {};
