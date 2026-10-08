#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';

const { main } = await tsImport('../src/cli.ts', import.meta.url);
process.exitCode = await main(process.argv.slice(2));
