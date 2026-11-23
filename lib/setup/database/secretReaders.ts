import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { ManagedIdentityCredential } from "@azure/identity";
import { SecretClient } from "@azure/keyvault-secrets";
import type { SecretReaders } from "./createdForYou";

/**
 * The real readers for "Created for you". Each uses the VM's own identity and nothing else: AWS's
 * default credential chain resolves to the instance role (IMDSv2), and Azure uses the VM's managed
 * identity explicitly, never a developer's local login. The secret's address comes from the
 * operator's POLYNOVEA_DB_SECRET_REF, already checked by parseSecretRef.
 */
export function cloudSecretReaders(): SecretReaders {
  return {
    async aws(ref) {
      const client = new SecretsManagerClient({ region: ref.region, maxAttempts: 2 });
      try {
        const result = await client.send(new GetSecretValueCommand({ SecretId: ref.arn }));
        return result.SecretString;
      } finally {
        client.destroy();
      }
    },
    async azure(ref) {
      const client = new SecretClient(ref.vaultUrl, new ManagedIdentityCredential());
      const secret = await client.getSecret(ref.name, ref.version ? { version: ref.version } : {});
      return secret.value;
    },
  };
}
