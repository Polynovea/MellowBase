/**
 * navigator.credentials.create() for the options @simplewebauthn/server made, and the result back as
 * the JSON it verifies. Uses the browser's own JSON helpers where they exist.
 */

type CreationOptionsJSON = {
  challenge: string;
  user: { id: string; name: string; displayName: string };
  excludeCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
  [key: string]: unknown;
};

const toBytes = (value: string): ArrayBuffer => {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
};

const toBase64url = (buffer: ArrayBuffer): string => {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && Boolean(navigator.credentials?.create);
}

export async function createPasskey(options: CreationOptionsJSON): Promise<Record<string, unknown>> {
  const parse = (PublicKeyCredential as unknown as { parseCreationOptionsFromJSON?: (o: unknown) => PublicKeyCredentialCreationOptions }).parseCreationOptionsFromJSON;
  const publicKey: PublicKeyCredentialCreationOptions = parse
    ? parse(options)
    : ({
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: options.excludeCredentials?.map((credential) => ({ ...credential, id: toBytes(credential.id) })),
      } as unknown as PublicKeyCredentialCreationOptions);

  const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error("No passkey was created.");
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: toBase64url(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    response: {
      clientDataJSON: toBase64url(response.clientDataJSON),
      attestationObject: toBase64url(response.attestationObject),
      transports: typeof response.getTransports === "function" ? response.getTransports() : [],
    },
  };
}
