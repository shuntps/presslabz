/**
 * Loads the server's whole module graph the way the server itself is loaded.
 *
 * Node runs this API directly from TypeScript: it strips types rather than
 * compiling them, and refuses the syntax that would need real emit. Nothing
 * else in the pipeline sees that. A constructor parameter property reached
 * main once with `tsc --noEmit`, Vitest and the build all green, and failed at
 * boot with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX — Vitest transpiles through
 * esbuild, which supports the syntax, and the type checker never emits at all.
 *
 * `node --check` does not close the gap either: measured, it exits 0 on a file
 * with a parameter property, and it reads one file rather than following its
 * imports. So this loads the real entry, which pulls in every module the
 * server loads, through Node's own loader.
 *
 * Importing `index.ts` does not start anything: the listen is behind
 * `import.meta.main`. No connection is opened, no bucket created, no port
 * bound, and nothing is written anywhere. A valid environment is still
 * required, because `env.ts` parses it at import — which is itself worth
 * proving before a deployment does it.
 */
const entry = new URL('../src/index.ts', import.meta.url)

await import(entry.href)

// console.warn rather than log, the way seed.ts reports what it did: the
// linter allows warn and error, and a script that says nothing on success is a
// script nobody can tell ran.
console.warn(`loaded ${entry.pathname} under Node ${process.version}: types stripped, no bundler`)
