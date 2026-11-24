/**
 * Signs a maintenance script in to a running CMS the way the admin UI does, and gives back one
 * `request(path, init)` for the CMS API. Used by `npm run seed:starter`.
 *
 * - AUTH_PROVIDER=builtin: email and password at /api/auth/sign-in/email with a cookie jar. If the
 *   account has a second factor (owners and admins always do), the one-time code from the
 *   authenticator app, or one recovery code, is required. API calls then carry the session cookie,
 *   the Origin, and the session's CSRF token from /api/auth/csrf, as the browser sends them.
 * - AUTH_PROVIDER=supabase (the default while GoTrue is the rollback path): password sign-in with
 *   the anon key; API calls carry the access token.
 */

/** Same rule as lib/auth/settings.ts parseAuthProvider. */
export function scriptAuthProvider(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "supabase";
  if (value === "supabase" || value === "builtin") return value;
  throw new Error("AUTH_PROVIDER must be one of supabase, builtin");
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function apiError(body, response) {
  return new Error(body?.error || body?.message || `${response.status} ${response.statusText}`);
}

/** A cookie jar that follows Set-Cookie, including deletions. */
function cookieJar() {
  const cookies = new Map();
  return {
    header: () => [...cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    size: () => cookies.size,
    absorb(response) {
      const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
      for (const setCookie of setCookies) {
        const [pair, ...attributes] = setCookie.split(";");
        const eq = pair.indexOf("=");
        if (eq < 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!value || attributes.some((attribute) => /max-age=0\b/i.test(attribute.trim()))) cookies.delete(name);
        else cookies.set(name, value);
      }
    },
  };
}

/**
 * @param {{ baseUrl: string, email: string, password: string, code?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ request: (path: string, init?: RequestInit) => Promise<any> }>}
 */
export async function signInBuiltin({ baseUrl, email, password, code, fetchImpl = fetch }) {
  const origin = new URL(baseUrl).origin;
  const jar = cookieJar();

  async function auth(path, body) {
    const response = await fetchImpl(`${baseUrl}/api/auth${path}`, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...(jar.size() ? { cookie: jar.header() } : {}) },
      body: JSON.stringify(body),
    });
    jar.absorb(response);
    const json = await readJson(response);
    if (!response.ok) {
      const detail = json?.message || json?.error || `${response.status} ${response.statusText}`;
      throw new Error(`Sign-in step ${path} failed: ${detail}`);
    }
    return json;
  }

  const signedIn = await auth("/sign-in/email", { email, password });
  if (signedIn?.twoFactorRedirect) {
    const value = String(code ?? "").trim();
    if (!value) {
      throw new Error("This account has a second factor. Pass --code=<6-digit code from your authenticator app> (or one recovery code).");
    }
    // Six digits is an authenticator-app code; anything else is treated as a recovery code.
    if (/^\d{6}$/.test(value)) await auth("/two-factor/verify-totp", { code: value });
    else await auth("/two-factor/verify-backup-code", { code: value });
  }

  const csrfResponse = await fetchImpl(`${baseUrl}/api/auth/csrf`, { headers: { cookie: jar.header() } });
  const csrf = await readJson(csrfResponse);
  if (!csrfResponse.ok || !csrf?.data?.token) {
    throw new Error(`Signed in, but the CMS did not issue a CSRF token (${csrfResponse.status}). Is the app running with AUTH_PROVIDER=builtin?`);
  }
  const token = csrf.data.token;

  return {
    async request(path, init = {}) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { cookie: jar.header(), origin, "x-polynovea-csrf": token, "content-type": "application/json", ...init.headers },
      });
      const body = await readJson(response);
      if (!response.ok) throw apiError(body, response);
      return body?.data;
    },
  };
}

/**
 * @param {{ baseUrl: string, email: string, password: string, supabaseUrl?: string, anonKey?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ request: (path: string, init?: RequestInit) => Promise<any> }>}
 */
export async function signInSupabase({ baseUrl, email, password, supabaseUrl, anonKey, fetchImpl = fetch }) {
  if (!supabaseUrl || !anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required when AUTH_PROVIDER=supabase.");
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: login, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !login.session) throw error || new Error("Owner sign-in did not return a session.");
  const accessToken = login.session.access_token;
  return {
    async request(path, init = {}) {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", ...init.headers },
      });
      const body = await readJson(response);
      if (!response.ok) throw apiError(body, response);
      return body?.data;
    },
  };
}

/**
 * Sign in with whichever auth the CMS runs.
 * @param {{ provider?: string, baseUrl: string, email: string, password: string, code?: string, supabaseUrl?: string, anonKey?: string, fetchImpl?: typeof fetch }} options
 */
export async function signInToCms({ provider, ...options }) {
  return scriptAuthProvider(provider) === "builtin" ? signInBuiltin(options) : signInSupabase(options);
}
