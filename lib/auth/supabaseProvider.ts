import type { Session as SupabaseSession, User as SupabaseUser } from "@supabase/supabase-js";
import type { BrowserIdentityProvider, ServerIdentityProvider, Session, User } from "@/lib/auth/provider";
import { createServiceRoleClient } from "@/lib/admin/serviceRole";
import { supabase } from "@/lib/supabase";

const toError = (error: { message: string } | null): Error | null => error ? new Error(error.message) : null;

/** GoTrue's user, reduced to the CMS's neutral identity type. */
export function toIdentityUser(user: SupabaseUser | null | undefined): User | null {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    metadata: user.user_metadata && typeof user.user_metadata === "object" ? { ...user.user_metadata } : {},
  };
}

/** GoTrue's session, reduced to the CMS's neutral session type. */
export function toIdentitySession(session: SupabaseSession | null | undefined): Session | null {
  if (!session) return null;
  const user = toIdentityUser(session.user);
  if (!user) return null;
  return { accessToken: session.access_token, expiresAt: session.expires_at ?? null, user };
}

/** Current first-class identity adapter. It is intentionally named rather
 * than hidden so unsupported providers are never mistaken for working ones. */
export function getSupabaseBrowserIdentityProvider(): BrowserIdentityProvider {
  return {
    async signInWithPassword(input) {
      const { data, error } = await supabase.auth.signInWithPassword(input);
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async getSession() {
      const { data, error } = await supabase.auth.getSession();
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async refreshSession() {
      const { data, error } = await supabase.auth.refreshSession();
      return { session: toIdentitySession(data.session), error: toError(error) };
    },
    async signOut() {
      const { error } = await supabase.auth.signOut();
      return { error: toError(error) };
    },
    onSessionChange(listener) {
      const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => listener(toIdentitySession(session)));
      return { unsubscribe: () => subscription.unsubscribe() };
    },
  };
}

export function getSupabaseServerIdentityProvider(): ServerIdentityProvider {
  const client = createServiceRoleClient();
  return {
    async verifyBearerToken(token) {
      const { data, error } = await client.auth.getUser(token);
      return { user: toIdentityUser(data.user), error: toError(error) };
    },
    async createUser(input) {
      const { data, error } = await client.auth.admin.createUser({
        email: input.email,
        password: input.password,
        email_confirm: input.emailConfirmed,
        user_metadata: input.metadata,
      });
      return { user: toIdentityUser(data.user), error: toError(error) };
    },
    async updateUser(id, input) {
      const { error } = await client.auth.admin.updateUserById(id, {
        ...(input.password ? { password: input.password } : {}),
        ...(input.metadata ? { user_metadata: input.metadata } : {}),
      });
      return { error: toError(error) };
    },
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      return { error: toError(error) };
    },
  };
}
