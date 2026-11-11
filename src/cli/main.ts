#!/usr/bin/env node
import { VERSION } from "../version.ts";

// Entry point for the `mingle` command. Commands are added in M1 (docs/spec.md section 5).
const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  console.log(VERSION);
} else {
  console.log(`mingle ${VERSION}\nNothing to run yet. See docs/spec.md.`);
}
