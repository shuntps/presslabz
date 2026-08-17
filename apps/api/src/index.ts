import { buildApp } from './app.ts'
import { env } from './env.ts'

async function start(): Promise<void> {
  const app = await buildApp()

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.close().then(
        () => process.exit(0),
        () => process.exit(1),
      )
    })
  }

  try {
    await app.listen({ host: env.API_HOST, port: env.API_PORT })
  } catch (error) {
    app.log.error(error)
    process.exit(1)
  }
}

/*
 * Only when Node was pointed at this file.
 *
 * Importing it is how the module graph is checked against the runtime that
 * actually runs it — see scripts/native-load-check.ts — and that check must
 * not open a database connection, create a bucket or bind a port. Without the
 * guard the only way to load the graph is to start the server.
 */
if (import.meta.main) {
  await start()
}
