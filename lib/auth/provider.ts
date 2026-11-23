/**
 * Identity types owned by the CMS, so the auth library behind this interface (Supabase GoTrue or the
 * built-in Better Auth) can change without touching the rest of the code.
 */
export interface User {
  /** Stable identity ID; admin_users.auth_user_id points at it. */
  id: string;
  email: string | null;
  /** ISO timestamp of email confirmation, or null when the address is unconfirmed. */
  emailConfirmedAt: string | null;
  /** Self-service profile data (display name and the like). Never used for authorization. */
  metadata: Record<string, unknown>;
}

export interface Session {
  /**
   * Bearer token the admin UI sends to the API. Empty for the built-in provider, whose session lives
   * in an HttpOnly cookie that the browser sends by itself.
   */
  accessToken: string;
  /** Expiry as Unix seconds, or null when the provider does not say. */
  expiresAt: number | null;
  user: User;
}

/** How the credential reached the server. Cookie credentials need CSRF checks on state-changing requests. */
export type CredentialTransport = "cookie" | "bearer";

/** A request whose credential the provider has verified. */
export interface RequestIdentity {
  user: User;
  /** Provider session ID (never the secret token), or null when the provider has none. */
  sessionId: string | null;
  /**
   * When the user last proved who they are (password, passkey or code), used by step-up checks.
   * Null when the provider cannot tell; step-up then fails closed.
   */
  authenticatedAt: Date | null;
  transport: CredentialTransport;
  /**
   * Second factors the user has registered (an authenticator app and each passkey count one), or
   * null when the provider does not report it (Supabase: GoTrue keeps its own MFA rules).
   */
  authenticators: number | null;
}

/**
 * Provider boundary for identity. CMS authorization deliberately remains
 * outside this interface: an external identity is resolved to admin_user,
 * workspace membership, roles, permissions and model policy by platform code.
 */
export interface BrowserIdentityProvider {
  signInWithPassword(input: { email: string; password: string }): Promise<{ session: Session | null; error: Error | null }>;
  getSession(): Promise<{ session: Session | null; error: Error | null }>;
  refreshSession(): Promise<{ session: Session | null; error: Error | null }>;
  signOut(): Promise<{ error: Error | null }>;
  onSessionChange(listener: (session: Session | null) => void): { unsubscribe(): void };
}

export interface ServerIdentityProvider {
  /**
   * Verifies the credential the request carries: the session cookie for the built-in provider, the
   * `Authorization: Bearer` header for Supabase. Takes the whole request so each provider reads what
   * it needs; it never trusts anything else in it.
   */
  verifyRequest(request: Request): Promise<{ identity: RequestIdentity | null; error: Error | null }>;
  createUser(input: { email: string; password: string; emailConfirmed: boolean; metadata?: Record<string, unknown> }): Promise<{ user: User | null; error: Error | null }>;
  updateUser(id: string, input: { password?: string; metadata?: Record<string, unknown> }): Promise<{ error: Error | null }>;
  deleteUser(id: string): Promise<{ error: Error | null }>;
  /** Ends every session of a user (sign out everywhere; also used after role and password changes). */
  revokeUserSessions(id: string): Promise<{ error: Error | null }>;
}
