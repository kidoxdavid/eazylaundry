import 'reflect-metadata';
import { createApp } from './app.factory.js';
import { loadConfig } from './config.js';

const cfg = loadConfig();
const app = await createApp(cfg);
await app.listen(cfg.port);
console.log(`EazyLaundry API listening on :${cfg.port}`);
