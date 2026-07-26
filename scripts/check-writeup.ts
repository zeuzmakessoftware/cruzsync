/**
 * Enforces the Kaggle writeup's 1,500-word limit.
 *
 * Counts prose words the way a human reader would: markdown syntax, code fences
 * and table pipes are stripped first, so we neither undercount nor pad.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LIMIT = 1500;
const path = resolve(process.cwd(), 'docs/kaggle-writeup.md');

const raw = readFileSync(path, 'utf8');

const prose = raw
  .replace(/```[\s\S]*?```/g, ' ') // fenced code blocks
  .replace(/`[^`]*`/g, ' ') // inline code
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links/images -> their text
  .replace(/^[#>\-*|]+/gm, ' ') // markdown leaders
  .replace(/[*_~]/g, ' ')
  .replace(/\|/g, ' ');

const words = prose.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));

console.log(`docs/kaggle-writeup.md: ${words.length} words (limit ${LIMIT})`);

if (words.length > LIMIT) {
  console.error(`FAIL: ${words.length - LIMIT} words over the limit.`);
  process.exit(1);
}
console.log(`OK: ${LIMIT - words.length} words of headroom.`);
