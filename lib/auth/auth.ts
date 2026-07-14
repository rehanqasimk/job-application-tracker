import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { initializeUserBoard } from "../init-user-board";
import { generateSlug, ensureUniqueSlug } from "../tenant/slug";
import connectDB from "../db";

const ROOT_DOMAIN = process.env.ROOT_DOMAIN;

// Build the better-auth instance LAZILY, on first use, instead of at module
// load. Previously a top-level `await connectDB()` opened the DB connection just
// by importing this file — blocking cold starts (and `next build`) with a Mongo
// handshake before any request ran. Memoizing the PROMISE means concurrent
// cold-start requests share a single initialization instead of racing. (005-perf-leaks)
let authPromise: ReturnType<typeof createAuth> | null = null;

async function createAuth() {
  const mongooseInstance = await connectDB();
  const client = mongooseInstance.connection.getClient();
  const db = client.db();

  return betterAuth({
    database: mongodbAdapter(db, {
      client,
    }),
    session: {
      // Signed session-cache cookie — proxy.ts verifies it at the edge via
      // getCookieCache() with no DB call. The whole tenant router depends on it.
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60,
      },
    },
    // Share auth cookies across every tenant subdomain so a session created at
    // the apex is readable at <slug>.<ROOT_DOMAIN>.
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: ROOT_DOMAIN,
      },
    },
    // Allow requests from tenant subdomains (wildcard covers user1.lvh.me, …).
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
        // Tenant subdomain slug — assigned server-side at sign-up, never from
        // client input, unique, and serialized into the session-cache cookie so
        // the edge can read it.
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
}

/**
 * Lazily-initialized, memoized better-auth instance. Use this instead of a
 * top-level `auth` export — the DB connection happens on first request, not at
 * import time.
 */
export function getAuth() {
  if (!authPromise) authPromise = createAuth();
  return authPromise;
}

export async function getSession() {
  const auth = await getAuth();
  const result = await auth.api.getSession({
    headers: await headers(),
  });

  return result;
}

export async function signOut() {
  const auth = await getAuth();
  const result = await auth.api.signOut({
    headers: await headers(),
  });

  if (result.success) {
    redirect("/sign-in");
  }
}
