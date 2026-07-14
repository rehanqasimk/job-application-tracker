import { getAuth } from "@/lib/auth/auth";
import { toNextJsHandler } from "better-auth/next-js";

// Build the handler lazily (and once) from the memoized auth instance, so this
// route no longer forces auth/DB initialization at module load. (005-perf-leaks)
let handlerPromise: Promise<ReturnType<typeof toNextJsHandler>> | null = null;

function getHandler() {
  if (!handlerPromise) {
    handlerPromise = getAuth().then((auth) => toNextJsHandler(auth));
  }
  return handlerPromise;
}

export async function GET(request: Request) {
  const { GET } = await getHandler();
  return GET(request);
}

export async function POST(request: Request) {
  const { POST } = await getHandler();
  return POST(request);
}
