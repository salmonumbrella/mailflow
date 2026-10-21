import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const NAME = 'mailflow-mcp';
export const VERSION = pkg.version;
export const USER_AGENT = `${NAME}/${VERSION}`;
