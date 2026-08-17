import { existsSync, copyFileSync } from 'node:fs';
if (!existsSync('.env')) copyFileSync('.env.example', '.env');
console.log('NNIT Studio environment prepared. Run: npm install && npm run db:init && npm run dev:core');
