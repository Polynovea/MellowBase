import { randomBytes } from "node:crypto";
import { StorageSharedKeyCredential, type UserDelegationKey } from "@azure/storage-blob";
import { describe, expect, it } from "vitest";
import { assertBlobEndpoint, azureSettingsFrom, readSasQuery } from "@/lib/media/azureBlobStorage";

const conn = "DefaultEndpointsProtocol=http;AccountName=dev;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:10000/dev;";

describe("Azure Blob settings", () => {
  it("accepts a managed-identity configuration", () => {
    expect(azureSettingsFrom({ accountName: "polynoveamedia", container: "media", publicUrl: "https://cdn.example.com/" }, {}, "production")).toEqual({
      container: "media", accountName: "polynoveamedia", endpoint: undefined, managedIdentityClientId: undefined, connectionString: undefined, publicUrl: "https://cdn.example.com",
    });
  });

  it("accepts connection strings only in Local and Development environments", () => {
    expect(azureSettingsFrom({ container: "media" }, { connection_string: conn }, "local").connectionString).toBe(conn);
    expect(azureSettingsFrom({ container: "media" }, { connection_string: conn }, "development").connectionString).toBe(conn);
    for (const kind of ["staging", "production", "custom"] as const) {
      expect(() => azureSettingsFrom({ accountName: "acct123", container: "media" }, { connection_string: conn }, kind)).toThrow(/managed identity/);
    }
  });

  it("validates names before they reach a URL", () => {
    for (const container of ["", "Media", "a", "-media", "me--dia", "media/../x", "x".repeat(64)]) {
      expect(() => azureSettingsFrom({ accountName: "acct123", container }, {}, "production")).toThrow(/container/);
    }
    for (const accountName of ["ab", "Upper", "has-dash", "x".repeat(25), "evil.example.com"]) {
      expect(() => azureSettingsFrom({ accountName, container: "media" }, {}, "production")).toThrow(/account name/);
    }
    expect(() => azureSettingsFrom({ container: "media" }, {}, "production")).toThrow(/account name is required/);
    expect(() => azureSettingsFrom({ accountName: "acct123", container: "media", managedIdentityClientId: "not-a-guid" }, {}, "production")).toThrow(/GUID/);
  });
});

describe("Azure Blob endpoint", () => {
  it("allows only Azure blob hosts over HTTPS outside Local environments, including private endpoints", async () => {
    for (const ok of ["https://acct123.blob.core.windows.net", "https://acct123.blob.core.usgovcloudapi.net/", "https://acct123.blob.core.chinacloudapi.cn"]) {
      await expect(assertBlobEndpoint(ok, "production")).resolves.toBeUndefined();
    }
    for (const bad of ["http://acct123.blob.core.windows.net", "https://169.254.169.254", "https://internal.corp", "https://blob.core.windows.net.evil.com", "https://u:p@acct123.blob.core.windows.net", "https://acct123.blob.core.windows.net:8443", "not a url"]) {
      await expect(assertBlobEndpoint(bad, "production")).rejects.toThrow();
    }
  });

  it("allows local HTTP (Azurite) only in Local environments", async () => {
    await expect(assertBlobEndpoint("http://127.0.0.1:10000/dev", "local")).resolves.toBeUndefined();
    await expect(assertBlobEndpoint("http://127.0.0.1:10000/dev", "development")).rejects.toThrow();
  });
});

describe("Azure read SAS", () => {
  const now = Date.parse("2026-11-23T10:00:00Z");
  const delegationKey: UserDelegationKey = {
    signedObjectId: "00000000-0000-0000-0000-000000000001",
    signedTenantId: "00000000-0000-0000-0000-000000000002",
    signedStartsOn: new Date(now - 60_000),
    signedExpiresOn: new Date(now + 2 * 3600_000),
    signedService: "b",
    signedVersion: "2025-01-05",
    value: randomBytes(32).toString("base64"),
  };

  it("is a user delegation SAS: read only, one blob, HTTPS only, one hour", () => {
    const query = new URLSearchParams(readSasQuery({ container: "media", blobName: "ws/general/a.png", signer: { kind: "user-delegation", key: delegationKey, accountName: "acct123" }, now }));
    expect(query.get("sp")).toBe("r");
    expect(query.get("sr")).toBe("b");
    expect(query.get("spr")).toBe("https");
    expect(query.get("skoid")).toBe(delegationKey.signedObjectId);
    expect(query.get("se")).toBe("2026-11-23T11:00:00Z");
    expect(query.get("st")).toBe("2026-11-23T09:55:00Z");
    expect(query.get("sig")).toBeTruthy();
  });

  it("signs with the account key for development connection strings, and allows HTTP only when asked", () => {
    const credential = new StorageSharedKeyCredential("dev", randomBytes(64).toString("base64"));
    const query = new URLSearchParams(readSasQuery({ container: "media", blobName: "ws/a.png", signer: { kind: "shared-key", credential }, allowHttp: true, now }));
    expect(query.get("sp")).toBe("r");
    expect(query.get("skoid")).toBeNull();
    expect(query.get("spr")).toBe("https,http");
  });
});
