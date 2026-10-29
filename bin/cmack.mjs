#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

// exitCode, not exit(): a write to a piped stdout can still be in flight.
process.exitCode = main(process.argv.slice(2));
