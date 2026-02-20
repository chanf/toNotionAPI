import { createHash } from "node:crypto";

const token = process.argv[2];

if (!token) {
  console.error("Usage: node scripts/hash-token.mjs <plain-token>");
  process.exit(1);
}

const hash = createHash("sha256").update(token, "utf8").digest("hex");
console.log(hash);
