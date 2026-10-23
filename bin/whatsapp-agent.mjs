#!/usr/bin/env node
// Check the Node version before loading anything: dist uses syntax and APIs an older Node cannot parse.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(`whatsapp-agent needs Node 22.12 or newer (found ${process.versions.node}).\n`);
  process.exit(1);
}
import('../dist/cli.js').catch((err) => {
  process.stderr.write(`whatsapp-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
