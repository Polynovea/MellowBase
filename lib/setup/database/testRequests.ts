import { peerStampEntryForTests, type PeerInfo } from "@/lib/setup/peerStamp";

/** A browser through an SSH tunnel to a server bound to 127.0.0.1, as the setup-code tests present it. */
export const TUNNEL: PeerInfo = { peer: "127.0.0.1", bound: "127.0.0.1", tls: false, forwarded: false };

/** Request headers carrying the real-connection stamp the setup guards read (lib/setup/peerStamp.ts). */
export function stampedHeaders(headers: Record<string, string>, connection: PeerInfo = TUNNEL): Headers {
  const all = new Headers(headers);
  all.set(...peerStampEntryForTests(connection));
  return all;
}
