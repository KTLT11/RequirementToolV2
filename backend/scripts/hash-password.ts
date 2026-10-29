// Standalone Argon2id password hasher for seeding the first app_users row.
//
// Deliberately does NOT touch the database and does NOT accept the
// password as a CLI argument or environment variable — both would be
// readable from shell history, process listings, or .env files. The
// only input path is an interactive, non-echoing terminal prompt.
//
// Usage:
//   npm run hash-password
//
// Output is the Argon2id hash only. Copy it into the password_hash
// value of 002_seed_initial_ba_user.sql. The plaintext password is
// never written to disk or printed back.

import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import * as argon2 from "argon2";

function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    const mutedOutput = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const rl = createInterface({
      input: process.stdin,
      output: mutedOutput,
      terminal: true,
    });

    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const password = await readSecret("New BA password: ");
  const confirm = await readSecret("Confirm password: ");

  if (password !== confirm) {
    console.error("Passwords did not match. Nothing was hashed.");
    process.exitCode = 1;
    return;
  }

  if (password.length < 12) {
    console.error(
      "Password must be at least 12 characters. Nothing was hashed.",
    );
    process.exitCode = 1;
    return;
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  console.log("\nArgon2id hash (paste this into password_hash):\n");
  console.log(hash);
}

main().catch((err) => {
  console.error("Hashing failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
