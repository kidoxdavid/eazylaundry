import { migrate } from './migrate.js';
const url = process.env.DATABASE_OWNER_URL;
if (!url) { console.error('DATABASE_OWNER_URL is required'); process.exit(1); }
migrate(url).then((a) => console.log(a.length ? `applied: ${a.join(', ')}` : 'up to date'))
  .catch((e) => { console.error(e.message); process.exit(1); });
