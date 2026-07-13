/**
 * One-off backfill: assign a unique `subdomain` slug to every existing user that
 * predates the tenant router. New users get a slug at sign-up (auth.ts); this
 * covers accounts created before that hook existed.
 *
 * Run:  npx tsx --env-file=.env scripts/backfill-subdomains.ts
 */
import mongoose from "mongoose";
import { generateSlug, ensureUniqueSlug, isValidSlug } from "../lib/tenant/slug";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set");

  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  if (!db) throw new Error("No database handle");

  const users = db.collection("user");

  // Only users missing a (valid) subdomain.
  const cursor = users.find({
    $or: [{ subdomain: { $exists: false } }, { subdomain: null }],
  });

  let updated = 0;
  for await (const user of cursor) {
    const email: string = user.email ?? `user-${user._id}`;
    const base = generateSlug(email);
    const subdomain = await ensureUniqueSlug(base, async (candidate) => {
      const existing = await users.findOne({ subdomain: candidate });
      return existing !== null;
    });

    if (!isValidSlug(subdomain)) {
      console.warn(`Skipping ${email}: generated invalid slug "${subdomain}"`);
      continue;
    }

    await users.updateOne({ _id: user._id }, { $set: { subdomain } });
    console.log(`  ${email} -> ${subdomain}`);
    updated++;
  }

  // Enforce uniqueness at the DB level going forward.
  await users.createIndex({ subdomain: 1 }, { unique: true, sparse: true });

  console.log(`\nBackfilled ${updated} user(s); unique index ensured.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
