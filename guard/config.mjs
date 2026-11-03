import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export function loadConfig(file) {
  const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
  return { ...read(join(dirname(file), 'defaults.json')), ...read(file) };
}
