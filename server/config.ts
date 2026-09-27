import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  pin: string;
  clientDir: string;
}

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Repo root: the compiled file lives in dist/server/, the source (run via tsx)
 * in server/.
 */
function repoRoot(): string {
  const parent = path.basename(path.dirname(here));
  return parent === 'dist' ? path.resolve(here, '..', '..') : path.resolve(here, '..');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = repoRoot();

  const portRaw = env.PORT ?? '3000';
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const pin = env.APP_PIN ?? '';
  if (!pin && env.NODE_ENV !== 'test') {
    throw new Error('APP_PIN is required. Set the APP_PIN environment variable to the shared PIN.');
  }

  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(root, 'data')),
    pin,
    clientDir: path.resolve(env.CLIENT_DIR || path.join(root, 'dist', 'client')),
  };
}
