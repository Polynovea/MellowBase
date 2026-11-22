/**
 * Identity types owned by the CMS, so the auth library behind this interface (Supabase GoTrue today,
 * Better Auth next) can change without touching the rest of the code.
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
  /** Bearer token the admin UI sends to the API. */
  accessToken: string;
  /** Expiry as Unix seconds, or null when the provider does not say. */
  expiresAt: number | null;
  user: User;
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
  verifyBearerToken(token: string): Promise<{ user: User | null; error: Error | null }>;
  createUser(input: { email: string; password: string; emailConfirmed: boolean; metadata?: Record<string, unknown> }): Promise<{ user: User | null; error: Error | null }>;
  updateUser(id: string, input: { password?: string; metadata?: Record<string, unknown> }): Promise<{ error: Error | null }>;
  deleteUser(id: string): Promise<{ error: Error | null }>;
}
