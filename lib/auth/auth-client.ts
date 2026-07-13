import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Talk to the SAME origin the client is rendered on — the apex OR any tenant
  // subdomain. Every host serves /api/auth, so same-origin always works and the
  // shared `.ROOT_DOMAIN` cookie is sent. Hardcoding the apex here made
  // useSession() a cross-origin call from a subdomain, which CORS blocked, so
  // the navbar rendered as logged-out. In the browser we use the current
  // origin; during SSR we fall back to the configured apex URL.
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
});

export const { signIn, signUp, signOut, useSession } = authClient;
