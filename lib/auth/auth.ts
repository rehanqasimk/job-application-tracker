import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { initializeUserBoard } from "../init-user-board";
import { generateSlug, ensureUniqueSlug } from "../tenant/slug";
import connectDB from "../db";

const ROOT_DOMAIN = process.env.ROOT_DOMAIN;

// NOTE: top-level `await connectDB()` at module load is a known cold-start
// blocker. It is intentionally left as-is here — the fix is tracked in the
// separate `002-perf-leaks` spec so this feature stays single-purpose.
const mongooseInstance = await connectDB();
const client = mongooseInstance.connection.getClient();
const db = client.db();

export const auth = betterAuth({
  database: mongodbAdapter(db, {
    client,
  }),
  session: {
    // Signed session-cache cookie. This is what makes edge validation possible:
    // proxy.ts reads/verifies it via getCookieCache() with no DB call. Keep it
    // enabled — the whole tenant router depends on it.
    cookieCache: {
      enabled: true,
      maxAge: 60 * 60,
    },
  },
  // Share the auth cookies across every tenant subdomain, so a session created
  // at the apex (lvh.me) is readable at user1.lvh.me. Without this the cookie is
  // host-only and every subdomain looks logged-out. `domain` applies to
  // *.<ROOT_DOMAIN>.
  advanced: {
    crossSubDomainCookies: {
      enabled: true,
      domain: ROOT_DOMAIN,
    },
  },
  // Allow requests from tenant subdomains (better-auth validates Origin against
  // baseURL; the wildcard covers user1.lvh.me, user2.lvh.me, …).
  trustedOrigins: ROOT_DOMAIN
    ? [
        `http://${ROOT_DOMAIN}:3000`,
        `https://${ROOT_DOMAIN}`,
        `http://*.${ROOT_DOMAIN}:3000`,
        `https://*.${ROOT_DOMAIN}`,
      ]
    : [],
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      // The tenant's subdomain slug. Assigned server-side at sign-up (below),
      // never accepted from client input. `unique` so two tenants can't share a
      // subdomain. Serialized into the session-cache cookie so the edge can read
      // it (data-model.md).
      subdomain: {
        type: "string",
        required: false,
        input: false,
        unique: true,
      },
    },
  },
  databaseHooks: {
    user: {
      create: {
        // Assign a unique subdomain before the user document is written.
        before: async (user) => {
          const base = generateSlug(user.email);
          const subdomain = await ensureUniqueSlug(base, async (candidate) => {
            const existing = await db
              .collection("user")
              .findOne({ subdomain: candidate });
            return existing !== null;
          });
          return { data: { ...user, subdomain } };
        },
        after: async (user) => {
          if (user.id) {
            await initializeUserBoard(user.id);
          }
        },
      },
    },
  },
});

export async function getSession() {
  const result = await auth.api.getSession({
    headers: await headers(),
  });

  return result;
}

export async function signOut() {
  const result = await auth.api.signOut({
    headers: await headers(),
  });

  if (result.success) {
    redirect("/sign-in");
  }
}
