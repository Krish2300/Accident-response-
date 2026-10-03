import 'dotenv/config';
import { loadServerConfig } from './config.js';
import { buildServer } from './app.js';

/**
 * Process entrypoint.
 *
 * Configuration errors are fatal and reported plainly. Everything else — an
 * unreachable database, a malformed protocol catalogue, a stopped LLM — degrades
 * rather than crashes, because losing the whole service on a dependency blip is
 * worse than running with a labelled limitation.
 */
async function main(): Promise<void> {
  const config = loadServerConfig();
  const server = await buildServer(config);

  // Fail fast on a malformed catalogue: a broken protocol file must not wait for
  // the first emergency to reveal it.
  const catalogue = await server.module5.preload();

  const shutdown = async (signal: string): Promise<void> => {
    server.logger.info({ signal }, 'received signal');
    await server.shutdown();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await server.fastify.listen({ port: config.port, host: config.host });

  server.logger.info(
    {
      port: config.port,
      host: config.host,
      env: config.nodeEnv,
      protocols: catalogue.protocols,
      steps: catalogue.steps,
    },
    'server ready',
  );

  if (!config.isProduction) {
    server.logger.info(
      { url: `http://localhost:${config.port}/dev/protocol-chat` },
      'Module 5 development harness',
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-console
  console.error(`[server] failed to start: ${message}`);
  process.exit(1);
});