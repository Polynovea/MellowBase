/**
 * A software WebAuthn authenticator for tests: an ES256 key pair that answers registration
 * ("none" attestation) and authentication challenges the way a platform authenticator would, with
 * user presence and user verification set. The origin it reports is chosen by the caller, which is
 * what the wrong-origin regression test needs.
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

// Minimal CBOR encoder: unsigned and negative integers, byte strings, text strings and maps.
function head(major: number, value: number): Buffer {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 256) return Buffer.from([(major << 5) | 24, value]);
  if (value < 65536) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(value, 1);
  return out;
}

type Cbor = number | string | Buffer | Map<number | string, Cbor>;

function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  const parts: Buffer[] = [head(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const b64url = (value: Buffer) => value.toString("base64url");
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest();

// Flags: user present (0x01) and user verified (0x04); 0x40 marks attested credential data.
const UP_UV = 0x05;
const AT = 0x40;

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Buffer;
  private signCount = 0;

  constructor(private readonly rpId: string) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.cosePublicKey = cbor(new Map<number, Cbor>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, Buffer.from(jwk.x, "base64url")],
      [-3, Buffer.from(jwk.y, "base64url")],
    ]));
  }

  private authData(flags: number, attested?: Buffer): Buffer {
    const count = Buffer.alloc(4);
    count.writeUInt32BE(this.signCount);
    return Buffer.concat([sha256(this.rpId), Buffer.from([flags]), count, ...(attested ? [attested] : [])]);
  }

  /** A navigator.credentials.create() result for the given options, as the browser would send it. */
  register(options: { challenge: string }, origin: string) {
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }));
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, this.cosePublicKey]);
    const attestationObject = cbor(new Map<string, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", this.authData(UP_UV | AT, attested)],
    ]));
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] },
    };
  }

  /** A navigator.credentials.get() result for the given options. */
  authenticate(options: { challenge: string }, origin: string, userHandle?: string) {
    this.signCount += 1;
    const clientDataJSON = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }));
    const authenticatorData = this.authData(UP_UV);
    const signature = sign("sha256", Buffer.concat([authenticatorData, sha256(clientDataJSON)]), this.privateKey);
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      clientExtensionResults: {},
      authenticatorAttachment: "platform",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authenticatorData),
        signature: b64url(signature),
        ...(userHandle ? { userHandle } : {}),
      },
    };
  }
}
