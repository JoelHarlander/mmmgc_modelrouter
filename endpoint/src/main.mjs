// The service entry point. A separate file, not an "am I the main module?" check in server.mjs:
// that check compares a real path with argv[1], and fails silently when the install path is
// reached through a symlink (/home -> /var/home on Fedora Atomic), exiting 0 having done nothing.
import { startServer } from "./server.mjs";

try {
  startServer();
} catch (err) {
  console.error(`router-endpoint: ${err.message}`);
  process.exit(1);
}
