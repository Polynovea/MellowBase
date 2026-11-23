"use client";

import { getBrowserIdentityProvider } from "@/lib/auth/browser";

// For the built-in auth the "token" is only a marker that a session exists: the session itself is an
// HttpOnly cookie, and the admin fetch wrapper strips the Authorization header before sending.
const identity = getBrowserIdentityProvider();

export async function isAuthenticated(): Promise<boolean> {
  const { session, error } = await identity.getSession();
  if (error) return false;
  return !!session;
}

export async function login(email: string, password: string): Promise<{ success: boolean; error?: string }> {
  const { error } = await identity.signInWithPassword({ email, password });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export async function logout(): Promise<void> {
  await identity.signOut();
}

export async function getAccessToken(): Promise<string | null> {
  const { session, error } = await identity.getSession();
  if (error || !session) return null;

  const expiresAt = (session.expiresAt ?? 0) * 1000;
  if (expiresAt < Date.now() + 30_000) {
    const { session: refreshedSession } = await identity.refreshSession();
    return refreshedSession?.accessToken ?? null;
  }

  return session.accessToken ?? null;
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}
