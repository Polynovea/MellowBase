"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@/lib/auth/provider";
import { getBrowserIdentityProvider, usesBuiltinAuth } from "@/lib/auth/browser";

/** Waits between retries when the session check itself fails (a busy server, a dropped connection). */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000];
import type { AdminUser } from "@/lib/admin/types";

export function useAdminAccess() {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<AdminUser | null>(null);
  const [accessError, setAccessError] = useState("");
  const [checked, setChecked] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const refresh = useCallback(() => {
    setRefreshKey((value) => value + 1);
  }, []);

  useEffect(() => {
    const identity = getBrowserIdentityProvider();
    const resolveProfile = async (nextSession: Session | null) => {
      setSession(nextSession);

      if (!nextSession) {
        setProfile(null);
        setAccessError("");
        setChecked(true);
        return;
      }

      try {
        const res = await fetch("/api/admin/me", {
          headers: {
            Authorization: `Bearer ${nextSession.accessToken}`,
            "Content-Type": "application/json",
          },
        });
        const json = await res.json().catch(() => null);
        if (!res.ok) {
          setProfile(null);
          setAccessError(
            res.status === 403
              ? "Your credentials are valid, but this account has not been granted CMS access. Ask an owner to provision or activate it."
              : (json?.error || "Could not verify CMS access."),
          );
          return;
        }
        setProfile(json?.data ?? null);
        setAccessError("");
      } catch {
        setProfile(null);
        setAccessError("Could not verify CMS access. Please try again.");
      } finally {
        setChecked(true);
      }
    };

    let cancelled = false;
    let retryTimer: number | undefined;
    const check = (attempt: number) => {
      identity.getSession().then(({ session: nextSession, error }) => {
        if (cancelled) return;
        if (error && usesBuiltinAuth()) {
          // The built-in auth reports a missing or revoked session as "no session", not as an error,
          // so an error here is the check itself failing (too many requests, a dropped connection).
          // It used to sign the person out; now it tries again, then says what happened.
          if (attempt < RETRY_DELAYS_MS.length) {
            retryTimer = window.setTimeout(() => check(attempt + 1), RETRY_DELAYS_MS[attempt]);
            return;
          }
          setSession(null);
          setProfile(null);
          setAccessError("We couldn't check your sign-in just now. Wait a minute, then reload the page; you are still signed in.");
          setChecked(true);
          return;
        }
        if (error) {
          // Supabase: a stale or revoked refresh token. Clear the local session and force a re-login.
          void identity.signOut();
          setSession(null);
          setProfile(null);
          setAccessError("");
          setChecked(true);
          return;
        }
        resolveProfile(nextSession);
      });
    };
    check(0);

    const subscription = identity.onSessionChange((nextSession) => {
      resolveProfile(nextSession);
    });

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      subscription.unsubscribe();
    };
  }, [refreshKey]);

  return {
    session,
    profile,
    checked,
    allowed: Boolean(session && profile),
    accessError,
    refresh,
  };
}
