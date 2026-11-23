"use client";

import type { BrowserIdentityProvider } from "@/lib/auth/provider";
import { browserAuthProvider } from "@/lib/auth/settings";
import { getSupabaseBrowserIdentityProvider } from "@/lib/auth/supabaseProvider";
import { getBuiltinBrowserIdentityProvider } from "@/lib/auth/builtinClient";

/** The browser identity provider selected by NEXT_PUBLIC_AUTH_PROVIDER (fixed at build time). */
export function getBrowserIdentityProvider(): BrowserIdentityProvider {
  return browserAuthProvider() === "builtin" ? getBuiltinBrowserIdentityProvider() : getSupabaseBrowserIdentityProvider();
}

export const usesBuiltinAuth = (): boolean => browserAuthProvider() === "builtin";
