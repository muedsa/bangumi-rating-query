import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { runCli } from '../cli/main.ts';

if (existsSync('.env')) loadEnvFile('.env');
await runCli(process.argv.slice(2));
