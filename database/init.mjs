import { readFileSync, existsSync, writeFileSync } from 'node:fs';
// Zero-dependency bootstrap marker. The API uses an in-memory store by default.
// schema.sql is production-ready for a SQLite adapter such as better-sqlite3/Prisma.
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
if (!existsSync(new URL('./.initialized', import.meta.url))) writeFileSync(new URL('./.initialized', import.meta.url), new Date().toISOString());
console.log(`Database schema ready (${schema.split('\n').length} lines).`);
