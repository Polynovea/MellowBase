import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseDatabaseSecret, parseSecretRef, SECRET_MALFORMED } from "@/lib/setup/database/createdForYou";
import { AWS_REGIONS, loadRelease, releaseGaps, renderCfn, signedReleaseGaps } from "./scripts/release-templates.mjs";
import { checkReleaseKey, COPIES, expectedOutputs, findSources, RELEASE_KEY, renderBootstrap, START_COMMAND, VM_FILES } from "./scripts/sync-vm-bootstrap.mjs";

/**
 * The cloud templates in deploy/ hand the setup wizard two things: POLYNOVEA_DB_SECRET_REF (where the
 * database login is) and the secret itself (the login, as JSON). These tests check both against the
 * Phase 2 parser that reads them, and check the security properties the templates promise. No cloud
 * account is used; deploy/scripts/validate.sh runs the real linters and policy scanners.
 */

const DEPLOY = path.join(process.cwd(), "deploy");
const read = (file: string) => readFileSync(path.join(DEPLOY, file), "utf8");

const cfn = read("aws/polynovea.yaml");
const bicep = read("azure/main.bicep");
const tofuAws = read("opentofu/modules/aws/main.tf");
const tofuAzure = read("opentofu/modules/azure/main.tf");
const armPath = path.join(DEPLOY, "azure/azuredeploy.json");

/** One top-level resource's YAML block in the CloudFormation template (two-space indent). */
function cfnResource(name: string): string {
  const start = cfn.indexOf(`\n  ${name}:\n`);
  expect(start, `resource ${name}`).toBeGreaterThan(0);
  const rest = cfn.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

const bootstrap = read("scripts/vm-bootstrap.sh");

/** The CloudFormation user data's settings part (before the generated bootstrap). */
function cfnSettings(): string {
  const server = cfnResource("Server");
  return server.slice(server.indexOf("UserData:"), server.indexOf("# BEGIN GENERATED vm-bootstrap"));
}

/** The bootstrap script CloudFormation's user data carries, unpacked (gzip + base64). */
function unpackCfnBootstrap(): string {
  const block = /<<'POLYNOVEA_BOOTSTRAP_END'\n([\s\S]+?)\n\s+POLYNOVEA_BOOTSTRAP_END/.exec(cfn)?.[1] ?? "";
  return gunzipSync(Buffer.from(block.replace(/\s+/g, ""), "base64")).toString("utf8");
}

/** One OpenTofu resource block, by "type" "name". */
function tfResource(text: string, type: string, name: string): string {
  const start = text.indexOf(`resource "${type}" "${name}" {`);
  expect(start, `${type}.${name}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end + 2);
}

/** Flexible Server's rule: 8-128 characters from at least three of upper, lower, digits, other. */
function meetsAzurePostgresComplexity(password: string): boolean {
  const classes = [/[A-Z]/, /[a-z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  return password.length >= 8 && password.length <= 128 && classes >= 3;
}

describe("AWS: the secret reference CloudFormation sets", () => {
  it("is the ARN of the stack's own Secrets Manager secret", () => {
    expect(cfnResource("DatabaseSecret")).toContain("Type: AWS::SecretsManager::Secret");
    // !Ref on AWS::SecretsManager::Secret returns its ARN.
    expect(cfn).toContain('!Sub "POLYNOVEA_DB_SECRET_REF=${DatabaseSecret}"');
    expect(cfnResource("ServerRole")).toContain("Resource: !Ref DatabaseSecret");
  });

  it("produces ARNs the wizard accepts, for every partition and any valid stack name", () => {
    const name = /Name: !Sub "(polynovea\/\$\{AWS::StackName\}\/database-admin)"/.exec(cfnResource("DatabaseSecret"))?.[1];
    expect(name).toBeDefined();
    const stacks = ["polynovea", "P", "my-cms-2026", `a${"b-1".repeat(42)}`.slice(0, 128)];
    const places = [["aws", "us-east-1"], ["aws", "eu-west-1"], ["aws", "ap-southeast-4"], ["aws", "il-central-1"], ["aws-us-gov", "us-gov-west-1"], ["aws-cn", "cn-northwest-1"]];
    for (const stack of stacks) {
      // CloudFormation stack names: a letter, then letters, digits and hyphens, at most 128.
      expect(stack).toMatch(/^[A-Za-z][A-Za-z0-9-]{0,127}$/);
      for (const [partition, region] of places) {
        // Secrets Manager appends a hyphen and six random characters to the name.
        const arn = `arn:${partition}:secretsmanager:${region}:123456789012:secret:${name!.replace("${AWS::StackName}", stack)}-Ab3xYz`;
        expect(parseSecretRef(arn), arn).toEqual({ kind: "aws", arn, region });
      }
    }
  });

  it("matches the OpenTofu module too", () => {
    expect(tofuAws).toContain('name                    = "polynovea/${var.name}/database-admin"');
    expect(read("opentofu/modules/aws/user-data.sh.tftpl")).toContain("POLYNOVEA_DB_SECRET_REF=${secret_arn}");
    expect(tofuAws).toMatch(/secret_arn\s+= local\.managed \? aws_secretsmanager_secret\.database\[0\]\.arn/);
    const ref = `arn:aws:secretsmanager:eu-west-1:123456789012:secret:polynovea/polynovea/database-admin-Ab3xYz`;
    expect(parseSecretRef(ref)).toMatchObject({ kind: "aws" });
  });
});

describe("AWS: the secret's contents", () => {
  const generated = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";

  it("starts as the template's JSON with a generated password, then gains host, port and engine from the attachment", () => {
    const block = cfnResource("DatabaseSecret");
    const template = JSON.parse(/SecretStringTemplate: '(.+)'/.exec(block)![1]) as Record<string, unknown>;
    expect(block).toContain("GenerateStringKey: password");
    expect(template).toEqual({ username: "polynovea_admin", dbname: "polynovea", port: 5432 });

    // Before the attachment the secret has no host, and the wizard rightly refuses it. This is why the
    // RDS-managed master password (username and password only, not extendable) is not used.
    expect(() => parseDatabaseSecret(JSON.stringify({ ...template, password: generated }))).toThrow(SECRET_MALFORMED);

    expect(cfnResource("DatabaseSecretAttachment")).toMatch(/TargetType: AWS::RDS::DBInstance/);
    const attached = { ...template, password: generated, engine: "postgres", host: "polynovea-db.abc123xyz.us-east-1.rds.amazonaws.com", dbInstanceIdentifier: "polynovea-db" };
    expect(parseDatabaseSecret(JSON.stringify(attached))).toEqual({
      hostname: attached.host, port: 5432, database: "polynovea", user: "polynovea_admin", password: generated,
    });
  });

  it("feeds RDS the same login by dynamic reference, never as a template value", () => {
    const db = cfnResource("Database");
    expect(db).toContain("MasterUsername: !Sub \"{{resolve:secretsmanager:${DatabaseSecret}:SecretString:username}}\"");
    expect(db).toContain("MasterUserPassword: !Sub \"{{resolve:secretsmanager:${DatabaseSecret}:SecretString:password}}\"");
    expect(db).not.toContain("ManageMasterUserPassword");
    expect(cfn).not.toMatch(/NoEcho/); // no password parameter exists at all
  });

  it("is written by the OpenTofu module in the same shape", () => {
    const version = tfResource(tofuAws, "aws_secretsmanager_secret_version", "database");
    for (const key of ["engine", "host", "port", "username", "password", "dbname"]) expect(version).toMatch(new RegExp(`\\b${key}\\s+=`));
  });
});

describe("Azure: the secret reference Bicep sets", () => {
  it("is the Key Vault secret's versionless URI", () => {
    expect(bicep).toContain("'POLYNOVEA_DB_SECRET_REF=${databaseSecret.properties.secretUri}'");
    expect(bicep).toContain("var secretName = 'polynovea-database-admin'");
    expect(bicep).toContain("name: 'pnv-${uniqueString(resourceGroup().id, installId)}'");
  });

  it("produces URIs the wizard accepts (uniqueString gives 13 lowercase letters and digits)", () => {
    for (const suffix of ["abcdefghijklm", "0123456789abc", "z9y8x7w6v5u4t"]) {
      const uri = `https://pnv-${suffix}.vault.azure.net/secrets/polynovea-database-admin`;
      expect(parseSecretRef(uri), uri).toEqual({ kind: "azure", uri, vaultUrl: `https://pnv-${suffix}.vault.azure.net`, name: "polynovea-database-admin", version: null });
    }
    // OpenTofu: "pnv-" plus 10 lowercase letters and digits, the same URI from versionless_id.
    expect(tofuAzure).toContain('name                          = "pnv-${random_string.install.result}"');
    expect(tofuAzure).toContain("POLYNOVEA_DB_SECRET_REF=${azurerm_key_vault_secret.database[0].versionless_id}");
    expect(parseSecretRef("https://pnv-0a1b2c3d4z.vault.azure.net/secrets/polynovea-database-admin")).toMatchObject({ kind: "azure" });
  });

  it("writes the secret in the shape the wizard reads", () => {
    const value = /value: string\(\{([\s\S]+?)\}\)/.exec(bicep)?.[1] ?? "";
    for (const key of ["engine", "host", "port", "username", "password", "dbname"]) expect(value).toMatch(new RegExp(`\\b${key}:`));
    const secret = { engine: "postgres", host: "polynovea-db-abc.postgres.database.azure.com", port: 5432, username: "polynovea_admin", password: `P${randomUUID()}`, dbname: "polynovea" };
    expect(parseDatabaseSecret(JSON.stringify(secret))).toMatchObject({ hostname: secret.host, database: "polynovea", user: "polynovea_admin" });
  });
});

describe("Azure: the generated database password", () => {
  it("comes from newGuid() in a @secure() parameter, never uniqueString()", () => {
    expect(bicep).toMatch(/@secure\(\)\n@description\([^\n]+\)\nparam databaseAdminPassword string = 'P\$\{newGuid\(\)\}'/);
    expect(bicep).not.toMatch(/uniqueString\([^)]*\)[^\n]*(password|Password)/);
  });

  it("always meets Flexible Server's three-of-four complexity rule", () => {
    // "P" (upper), the hyphens (other) and the version digit "4" are in every value.
    for (let i = 0; i < 2000; i++) expect(meetsAzurePostgresComplexity(`P${randomUUID()}`)).toBe(true);
    for (const worst of ["00000000-0000-4000-8000-000000000000", "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa"]) {
      expect(meetsAzurePostgresComplexity(`P${worst}`)).toBe(true);
      expect(meetsAzurePostgresComplexity(worst)).toBe(worst.startsWith("a")); // without the prefix an all-digit GUID would fail
    }
    expect(`P${randomUUID()}`).toHaveLength(37);
  });
});

describe("policy: AWS CloudFormation", () => {
  it("requires IMDSv2 tokens, with hop limit 2 for the bridged container, and puts no secret in user data", () => {
    const launch = cfnResource("ServerLaunchTemplate");
    expect(launch).toMatch(/HttpTokens: required/);
    expect(launch).toMatch(/HttpPutResponseHopLimit: 2\n/);
    expect(launch).toMatch(/bridged\s+#?\s*container/);
    const server = cfnResource("Server");
    expect(server).toContain("LaunchTemplateId: !Ref ServerLaunchTemplate");
    expect(cfnSettings()).not.toMatch(/password|SecretString|resolve:secretsmanager/i);
    expect(unpackCfnBootstrap()).toBe(bootstrap); // the rest of user data is the release package's own script
  });

  it("names the PostgreSQL 16 minor version in one parameter, with automatic minor upgrades", () => {
    expect(cfn).toContain('  PostgresVersion:\n    Type: String\n    Default: "16.15"\n    AllowedPattern: "^16\\\\.[0-9]+$"\n');
    expect(cfnResource("Database")).toContain("AutoMinorVersionUpgrade: true");
    expect(read("opentofu/modules/aws/variables.tf")).toMatch(/variable "postgres_version" \{[\s\S]+?default\s+= "16\.\d+"/);
    expect(tfResource(tofuAws, "aws_db_instance", "database")).toMatch(/engine_version\s+= var\.postgres_version/);
    expect(bicep).toMatch(/version: '16'/); // Azure takes the major version; it applies minor updates itself
  });

  it("keeps the database private, encrypted, protected from deletion and backed up for 7 days", () => {
    const db = cfnResource("Database");
    for (const line of ["PubliclyAccessible: false", "StorageEncrypted: true", "DeletionProtection: true", "BackupRetentionPeriod: 7", "MultiAZ: false", 'EngineVersion: !Ref PostgresVersion', "DeletionPolicy: Snapshot"]) expect(db).toContain(line);
    const dbSg = cfnResource("DatabaseSecurityGroup");
    expect(dbSg).toContain("SourceSecurityGroupId: !Ref ServerSecurityGroup");
    expect(dbSg).not.toContain("0.0.0.0/0");
    expect(cfnResource("ServerToDatabaseEgress")).toContain("DestinationSecurityGroupId: !Ref DatabaseSecurityGroup");
  });

  it("encrypts every disk and the bucket, and keeps the bucket private and HTTPS-only", () => {
    expect(cfnResource("ServerLaunchTemplate")).toContain("Encrypted: true");
    expect(cfnResource("DataVolume")).toContain("Encrypted: true");
    const bucket = cfnResource("Bucket");
    for (const line of ["SSEAlgorithm: AES256", "BlockPublicAcls: true", "BlockPublicPolicy: true", "IgnorePublicAcls: true", "RestrictPublicBuckets: true", "DeletionPolicy: Retain"]) expect(bucket).toContain(line);
    expect(cfnResource("BucketPolicy")).toContain('"aws:SecureTransport": "false"');
  });

  it("gives the server one role that reads one secret and uses one bucket", () => {
    const role = cfnResource("ServerRole");
    const actions = [...role.matchAll(/Action: (\[[^\]]+\]|\S+)/g)].flatMap((m) => m[1].replace(/[[\]]/g, "").split(",").map((a) => a.trim()));
    expect(new Set(actions)).toEqual(new Set(["sts:AssumeRole", "s3:ListBucket", "s3:GetBucketLocation", "s3:GetObject", "s3:PutObject", "s3:DeleteObject", "secretsmanager:GetSecretValue"]));
    const resources = [...role.matchAll(/Resource: (.+)/g)].map((m) => m[1].trim());
    expect(resources).toEqual(["!GetAtt Bucket.Arn", '!Sub "${Bucket.Arn}/*"', "!Ref DatabaseSecret"]);
    expect(role).not.toMatch(/ManagedPolicyArns|"\*"/);
  });

  it("opens SSH only to AdminCidr, 80/443 only with a domain, and has a budget alert", () => {
    const sg = cfnResource("ServerSecurityGroup");
    expect(sg).toMatch(/- HasAdminCidr\n\s+- \{ IpProtocol: tcp, FromPort: 22, ToPort: 22, CidrIp: !Ref AdminCidr/);
    expect(sg).toMatch(/- HasDomain\n\s+- \{ IpProtocol: tcp, FromPort: 80, ToPort: 80, CidrIp: 0\.0\.0\.0\/0/);
    expect(sg).toMatch(/- HasDomain\n\s+- \{ IpProtocol: tcp, FromPort: 443, ToPort: 443, CidrIp: 0\.0\.0\.0\/0/);
    expect(sg.match(/0\.0\.0\.0\/0/g)).toHaveLength(4); // the two domain-only rules, and egress to 443 and 80
    expect(cfn).toMatch(/SomeWayIn:[\s\S]+AssertDescription/);
    expect(cfnResource("Budget")).toContain("Type: AWS::Budgets::Budget");
  });

  it("states the expected monthly cost with its region and date", () => {
    expect(cfn.slice(0, 800)).toMatch(/us-east-1 in November 2026[\s\S]*US\$34[\s\S]*US\$20/);
  });
});

describe.runIf(existsSync(armPath))("policy: Azure (compiled ARM JSON behind the Deploy to Azure button)", () => {
  type Resource = { type: string; name: string; properties?: any; scope?: string; condition?: string };
  const arm = existsSync(armPath) ? (JSON.parse(readFileSync(armPath, "utf8")) as { resources: Record<string, Resource> | Resource[]; metadata?: any }) : { resources: [] };
  const resources: Resource[] = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
  const ofType = (type: string) => resources.filter((r) => r.type === type);
  const one = (type: string) => { const list = ofType(type); expect(list, type).toHaveLength(1); return list[0]; };

  it("keeps the database private, on PostgreSQL 16, with 7-day backups and a delete lock", () => {
    const db = one("Microsoft.DBforPostgreSQL/flexibleServers").properties;
    expect(db.version).toBe("16");
    expect(db.network.publicNetworkAccess).toBe("Disabled");
    expect(db.backup).toEqual({ backupRetentionDays: 7, geoRedundantBackup: "Disabled" });
    expect(db.highAvailability.mode).toBe("Disabled");
    expect(one("Microsoft.DBforPostgreSQL/flexibleServers/configurations").properties.value).toBe("on");
    const locks = ofType("Microsoft.Authorization/locks");
    expect(locks.map((l) => l.properties.level)).toEqual(["CanNotDelete", "CanNotDelete", "CanNotDelete"]);
  });

  it("keeps storage private, Entra-only and encrypted, and Key Vault on RBAC with purge protection", () => {
    const storage = one("Microsoft.Storage/storageAccounts").properties;
    expect(storage).toMatchObject({ allowBlobPublicAccess: false, allowSharedKeyAccess: false, minimumTlsVersion: "TLS1_2", supportsHttpsTrafficOnly: true });
    expect(storage.encryption.requireInfrastructureEncryption).toBe(true);
    expect(one("Microsoft.Storage/storageAccounts/blobServices/containers").properties.publicAccess).toBe("None");
    const vault = one("Microsoft.KeyVault/vaults").properties;
    expect(vault).toMatchObject({ enableRbacAuthorization: true, enablePurgeProtection: true, enableSoftDelete: true });
    expect(vault.networkAcls.defaultAction).toBe("Deny");
  });

  it("gives the VM's identity exactly two roles: read one secret, use one container", () => {
    const assignments = ofType("Microsoft.Authorization/roleAssignments");
    expect(assignments).toHaveLength(2);
    // Each assignment pairs one built-in role with exactly one resource: the secret, or the container.
    const variables = (arm as { variables?: Record<string, unknown> }).variables ?? {};
    const pairs = assignments.map((a) => {
      const roleVar = /variables\('(\w+)'\)\)\]$/.exec(String(a.properties.roleDefinitionId))?.[1] ?? "";
      return { role: variables[roleVar], scope: String(a.scope) };
    });
    expect(pairs).toEqual(expect.arrayContaining([
      { role: "4633458b-17de-408a-b874-0445c86b69e6", scope: expect.stringMatching(/^\[resourceId\('Microsoft\.KeyVault\/vaults\/secrets',/) }, // Key Vault Secrets User
      { role: "ba92f5b4-2d11-453d-a403-e96b0029c9fe", scope: expect.stringMatching(/^\[resourceId\('Microsoft\.Storage\/storageAccounts\/blobServices\/containers',/) }, // Storage Blob Data Contributor
    ]));
  });

  it("uses SSH keys only, puts no secret in custom data, and has a budget alert", () => {
    const vm = one("Microsoft.Compute/virtualMachines").properties;
    expect(vm.osProfile.linuxConfiguration.disablePasswordAuthentication).toBe(true);
    expect(JSON.stringify(arm)).not.toMatch(/customData[^}]*databaseAdminPassword/);
    expect(bicep.slice(bicep.indexOf("var settings"), bicep.indexOf("resource vm "))).not.toMatch(/password/i);
    one("Microsoft.Consumption/budgets");
  });

  it("states the expected monthly cost with its region and date", () => {
    expect(String(arm.metadata?.description ?? "")).toMatch(/US\$56[\s\S]*US\$39[\s\S]*East US[\s\S]*November 2026/);
  });

  it("was compiled from the current first-boot script (run deploy/scripts/build-azure.sh if not)", () => {
    // Bicep stores loadTextContent() as a template variable ("$fxv#0"), the script's exact text.
    const json = JSON.stringify(arm);
    const forms = [bootstrap, bootstrap.replace(/'/g, "''")].map((t) => JSON.stringify(t).slice(1, -1));
    expect(forms.some((f) => json.includes(f)), "azuredeploy.json is stale: run bash deploy/scripts/build-azure.sh").toBe(true);
  });
});

describe("policy: OpenTofu", () => {
  it("requires state and plan encryption with a KMS or Key Vault key", () => {
    const aws = read("opentofu/examples/aws/main.tf");
    const azure = read("opentofu/examples/azure/main.tf");
    expect(aws).toMatch(/key_provider "aws_kms"/);
    expect(azure).toMatch(/key_provider "azure_vault"/);
    for (const text of [aws, azure]) {
      expect(text.match(/^\s+enforced\s+= true$/gm)).toHaveLength(2);
      expect(text).toMatch(/state \{\s+method\s+= method\.aes_gcm\.state/);
      expect(text).toMatch(/plan \{\s+method\s+= method\.aes_gcm\.state/);
    }
  });

  it("sets prevent_destroy on the databases, buckets and data disks", () => {
    for (const [text, type, name] of [
      [tofuAws, "aws_db_instance", "database"], [tofuAws, "aws_s3_bucket", "main"], [tofuAws, "aws_ebs_volume", "data"],
      [tofuAzure, "azurerm_postgresql_flexible_server", "main"], [tofuAzure, "azurerm_storage_account", "main"], [tofuAzure, "azurerm_managed_disk", "data"],
    ] as const) expect(tfResource(text, type, name), `${type}.${name}`).toMatch(/prevent_destroy = true/);
  });

  it("carries the same security settings as the templates", () => {
    expect(tfResource(tofuAws, "aws_instance", "server")).toMatch(/http_tokens\s+= "required"/);
    const db = tfResource(tofuAws, "aws_db_instance", "database");
    for (const re of [/publicly_accessible\s+= false/, /storage_encrypted\s+= true/, /deletion_protection\s+= true/, /backup_retention_period\s+= 7/]) expect(db).toMatch(re);
    expect(tfResource(tofuAzure, "azurerm_postgresql_flexible_server", "main")).toMatch(/public_network_access_enabled\s+= false/);
    expect(tfResource(tofuAzure, "azurerm_storage_account", "main")).toMatch(/shared_access_key_enabled\s+= false/);
  });
});

describe("the release package's contract (P5 W1's VM files and settings keys)", () => {
  const settings = {
    aws: cfnSettings(),
    azure: bicep.slice(bicep.indexOf("var settings"), bicep.indexOf("var cloudInit")),
    tofuAws: read("opentofu/modules/aws/user-data.sh.tftpl"),
    tofuAzure: tofuAzure.slice(tofuAzure.indexOf("settings = join"), tofuAzure.indexOf("cloud_init = join")),
  };

  it("writes the keys the image reads, and never the ones the image sets itself", () => {
    for (const [name, text] of Object.entries(settings)) {
      for (const key of ["POLYNOVEA_DB_SECRET_REF", "POLYNOVEA_DOMAIN", "POLYNOVEA_ACME_EMAIL", "POLYNOVEA_IMAGE_REF", "POLYNOVEA_CADDY_IMAGE_REF"]) expect(text, `${name}: ${key}`).toContain(`${key}=`);
      for (const key of ["HOSTNAME", "PORT", "POLYNOVEA_TRUSTED_PROXIES", "POLYNOVEA_CONFIG_DIR", "POLYNOVEA_PUBLIC_URL"]) expect(text, `${name}: ${key}`).not.toMatch(new RegExp(`(^|['"\s])${key}=`, "m"));
    }
    for (const text of [settings.aws, settings.tofuAws]) {
      expect(text).toContain("AWS_REGION=");
      expect(text).toContain("POLYNOVEA_BACKUP_BUCKET=");
    }
    for (const text of [settings.azure, settings.tofuAzure]) {
      expect(text).toContain("POLYNOVEA_BACKUP_ACCOUNT=");
      expect(text).toContain("POLYNOVEA_BACKUP_CONTAINER=");
    }
    for (const text of Object.values(settings)) expect(text).not.toMatch(/password/i);
  });

  it("installs nothing of its own: the first-boot script is generated from the release package's files", () => {
    expect(bootstrap).toMatch(/^#!\/bin\/sh\n# GENERATED by deploy\/scripts\/sync-vm-bootstrap\.mjs/);
    for (const unit of ["polynovea.service", "polynovea-caddy.service", "polynovea-data-disk.service", "var-lib-polynovea.mount", "polynovea-console-code.service", "console-code.sh", "verify-images.sh", "run-cms.sh", "provision.sh"]) {
      expect(bootstrap).toContain(`cat > "$FILES/${unit}" <<'POLYNOVEA_FILE_END'`);
    }
    for (const copy of COPIES) expect(readFileSync(path.join(process.cwd(), copy), "utf8"), copy).toBe(bootstrap);
    expect(unpackCfnBootstrap()).toBe(bootstrap);
    // Started outside cloud-init: provision.sh waits for cloud-init to finish.
    expect(cfn).toContain(START_COMMAND("aws"));
    expect(settings.tofuAws).toContain(START_COMMAND("aws"));
    expect(bicep).toContain("loadTextContent('../scripts/vm-bootstrap.sh')");
    expect(bicep).toContain("[systemd-run, --unit=polynovea-bootstrap");
    expect(tofuAzure).toContain('filebase64("${path.module}/vm-bootstrap.sh")');
  });

  const sources = findSources();
  it.runIf(sources !== null)("is in step with the release package's files in this checkout", () => {
    const contents = Object.fromEntries(Object.entries(sources!).map(([name, file]) => [name, readFileSync(file, "utf8")]));
    for (const [file, text] of Object.entries(expectedOutputs(contents))) {
      expect(readFileSync(path.join(process.cwd(), file), "utf8"), `${file} is stale: run node deploy/scripts/sync-vm-bootstrap.mjs`).toBe(text);
    }
  });

  it("tells the owner where the setup code is shown, with exact clicks", () => {
    expect(cfn).toMatch(/SetupCode:[\s\S]+Actions > Monitor and troubleshoot > Get system log/);
    expect(bicep).toMatch(/output setupCode string = '.*Help > Serial console/);
    expect(read("opentofu/modules/aws/outputs.tf")).toContain('output "setup_code"');
    expect(read("opentofu/modules/azure/outputs.tf")).toContain('output "setup_code"');
  });

  it("keeps CloudFormation's user data under EC2's 16 KB limit, with room for long values", () => {
    const server = cfnResource("Server");
    const literal = server.slice(server.indexOf("- |\n", server.indexOf("UserData:")));
    const dedented = literal.split("\n").map((l) => l.trim()).join("\n");
    // Substituted values: secret ARN, bucket, domain, email and two image references, generously.
    expect(dedented.length + 6 * 256).toBeLessThan(16 * 1024);
  });
});

describe("first boot fails closed", () => {
  // Stand-ins for the release package's files: these tests are about how the bootstrap is put together.
  const stand = Object.fromEntries(VM_FILES.map((name) => [name, `# ${name}\n`]));
  const throwawayKey = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();

  it("uses images only by digest, and leaves the signature check to the release package's units", () => {
    expect(bootstrap).toMatch(/^set -eu$/m);
    expect(bootstrap).toMatch(/must be pinned by digest/);
    // The release package verifies after pulling (provision.sh) and before every start (ExecStartPre).
    expect(bootstrap).toContain(`cat > "$FILES/verify-images.sh" <<'POLYNOVEA_FILE_END'`);
    expect(bootstrap).toMatch(/^ExecStartPre=\/opt\/polynovea\/verify-images\.sh$/m);
    expect(bootstrap).toMatch(/^\/opt\/polynovea\/verify-images\.sh$/m);
    // Plain Ubuntu: provision.sh starts the units itself (one start path, shared with the image).
    expect(bootstrap).toMatch(/POLYNOVEA_START_NOW=1 \\\n\s+sh "\$FILES\/provision\.sh"/);
    // Our own part (outside the release package's embedded files) no longer stops units after the fact.
    const ours = bootstrap.slice(0, bootstrap.indexOf(`cat > "$FILES/`)) + bootstrap.slice(bootstrap.lastIndexOf("POLYNOVEA_FILE_END\n"));
    expect(ours).not.toMatch(/\btrap\b|disable --now/);
  });

  it("carries the release public key from the release files, and only a public key", () => {
    const key = throwawayKey();
    const withKey = renderBootstrap({ ...stand, [RELEASE_KEY]: key });
    expect(withKey).toContain(`cat > "$FILES/${RELEASE_KEY}" <<'POLYNOVEA_FILE_END'\n${key}POLYNOVEA_FILE_END\n`);
    expect(withKey).not.toMatch(/No polynovea-release\.pub/);

    const privateKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => renderBootstrap({ ...stand, [RELEASE_KEY]: privateKey })).toThrow(/private key/);
    expect(() => renderBootstrap({ ...stand, [RELEASE_KEY]: key + privateKey })).toThrow(/private key/);
    expect(() => renderBootstrap({ ...stand, [RELEASE_KEY]: key + key })).toThrow(/exactly one PEM public key/);
    expect(() => renderBootstrap({ ...stand, [RELEASE_KEY]: "not a key\n" })).toThrow(/exactly one PEM public key/);
  });

  it("without a release key, says so, and provision.sh refuses to run (nothing starts)", () => {
    expect(renderBootstrap(stand)).toMatch(/# No polynovea-release\.pub in this build[\s\S]+fail closed/);
    // No real key exists yet, by design: the committed bootstrap must not contain one we made up.
    const hasKey = bootstrap.includes(`cat > "$FILES/${RELEASE_KEY}"`);
    expect(hasKey || /# No polynovea-release\.pub in this build/.test(bootstrap)).toBe(true);
    if (hasKey) expect(() => checkReleaseKey(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----\n/.exec(bootstrap)![0])).not.toThrow();
  });
});

describe("Azure server images", () => {
  it("uses the release's gallery image or Ubuntu, with Trusted Launch on x64", () => {
    expect(bicep).toContain("var galleryImage = loadJsonContent('../release-images.json').azure.galleryImages[architecture]");
    expect(bicep).toContain("imageReference: empty(galleryImage) ? ubuntuImage : { communityGalleryImageId: galleryImage }");
    expect(bicep).toContain("securityProfile: architecture == 'x64'");
    expect(bicep).not.toMatch(/param customImageId/);
    expect(tofuAzure).toContain('trusted_launch = var.architecture == "x64"');
    expect(read("README.md")).toContain("--features SecurityType=TrustedLaunchSupported");
  });
});

describe("review item 1: a link can't swap in someone else's images", () => {
  const digest = "a".repeat(64);
  const cfnPattern = (param: string) => {
    const block = cfnResource(param);
    const yaml = /AllowedPattern: "(.+)"/.exec(block)![1];
    return new RegExp(yaml.replaceAll("\\\\", "\\")); // YAML "\\." is the pattern \.
  };
  const tfPattern = (text: string, variable: string) => {
    const marker = `var.${variable} == "" || can(regex("`;
    const start = text.indexOf(marker) + marker.length;
    const hcl = text.slice(start, text.indexOf(`", var.${variable}))`, start));
    return new RegExp(hcl.replaceAll("\\\\", "\\")); // HCL "\\." is the pattern \.
  };
  const genuineCms = `ghcr.io/polynovea/cms@sha256:${digest}`;
  const genuineCaddy = [`caddy@sha256:${digest}`, `docker.io/library/caddy@sha256:${digest}`];
  const foreign = [
    `ghcr.io/attacker/cms@sha256:${digest}`, `docker.io/attacker/caddy@sha256:${digest}`, `ghcr.io/polynovea/cms:latest`,
    `ghcr.io/polynovea.evil.com/cms@sha256:${digest}`, `caddy:2`, `evil.example/caddy@sha256:${digest}`, `caddy@sha256:${"g".repeat(64)}`,
    `ghcr.io/polynovea/cms@sha256:${digest}\nPOLYNOVEA_DOMAIN=evil.example`,
  ];

  it("CloudFormation refuses a foreign CMS or Caddy image in a quick-create link", () => {
    const cms = cfnPattern("ContainerImage");
    const caddy = cfnPattern("CaddyImage");
    expect(cms.test("")).toBe(true);
    expect(cms.test(genuineCms)).toBe(true);
    for (const ok of genuineCaddy) expect(caddy.test(ok)).toBe(true);
    for (const bad of foreign) {
      if (bad !== genuineCms) expect(cms.test(bad), bad).toBe(false);
      if (!genuineCaddy.includes(bad)) expect(caddy.test(bad), bad).toBe(false);
    }
  });

  it("CloudFormation has no parameter that names the server's disk image", () => {
    expect(cfn).not.toMatch(/\n  (UbuntuImage|CustomImageId):\n/);
    expect(cfnResource("Server")).toMatch(/ImageId: !If\n\s+- HasReleaseAmi\n\s+- !FindInMap \[ReleaseAmis, !Ref AWS::Region, !Ref Architecture\]\n\s+- !Sub "\{\{resolve:ssm:\/aws\/service\/canonical\/ubuntu\/server\/24\.04\/stable\/current\/\$\{Architecture\}\/hvm\/ebs-gp3\/ami-id\}\}"/);
    expect(cfnResource("Architecture")).toContain("AllowedValues: [arm64, amd64]"); // the only free part of that path
    // Every region is in the map (FindInMap fails for a missing one), "none" until a release publishes.
    for (const region of AWS_REGIONS) expect(cfn).toMatch(new RegExp(`\n    ${region}: \{ arm64: (none|ami-[0-9a-f]+), amd64: (none|ami-[0-9a-f]+) \}`));
  });

  it("the release file accepts only Polynovea and Caddy images, and real AMI and gallery IDs", () => {
    const base = { release: false, cmsImage: "", caddyImage: "", aws: { amis: {} }, azure: { galleryImages: { x64: "", arm64: "" } } };
    expect(() => loadRelease(JSON.stringify({ ...base, cmsImage: genuineCms, caddyImage: genuineCaddy[0] }))).not.toThrow();
    expect(() => loadRelease(JSON.stringify({ ...base, cmsImage: `ghcr.io/attacker/cms@sha256:${digest}` }))).toThrow(/cmsImage/);
    expect(() => loadRelease(JSON.stringify({ ...base, caddyImage: `docker.io/attacker/caddy@sha256:${digest}` }))).toThrow(/caddyImage/);
    expect(() => loadRelease(JSON.stringify({ ...base, aws: { amis: { "eu-west-1": { arm64: "attacker" } } } }))).toThrow(/AMI/);
    expect(() => loadRelease(JSON.stringify({ ...base, azure: { galleryImages: { x64: "/subscriptions/x/resourceGroups/y/providers/Microsoft.Compute/images/z" } } }))).toThrow(/gallery/);
    // The committed release file is valid and the template is in step with it.
    const release = loadRelease(read("release-images.json"));
    expect(renderCfn(cfn, release)).toBe(cfn);
    const published = renderCfn(cfn, { ...release, cmsImage: genuineCms, caddyImage: genuineCaddy[0], aws: { amis: { "eu-west-1": { arm64: "ami-0123456789abcdef0", amd64: "" } } } });
    expect(published).toContain(`\n  ContainerImage:\n    Type: String\n    Default: "${genuineCms}"`);
    expect(published).toContain("\n    eu-west-1: { arm64: ami-0123456789abcdef0, amd64: none }");
  });

  it("Bicep checks the images before creating anything, and has no free image parameter", () => {
    expect(bicep).toContain("param containerImage string = loadJsonContent('../release-images.json').cmsImage");
    expect(bicep).toContain("param caddyImage string = loadJsonContent('../release-images.json').caddyImage");
    expect(bicep).toContain("containerImageMustBeThePolynoveaImageFromGhcrPinnedByDigest: empty(containerImage) || isPolynoveaImage(containerImage)");
    expect(bicep).toContain("caddyImageMustBeCaddysOfficialImagePinnedByDigest: empty(caddyImage) || isDigestRef(caddyImage, ['caddy', 'docker.io/library/caddy'])");
    expect(bicep).toMatch(/parameters: toObject\(items\(inputRules\), rule => rule\.key, rule => \{ type: 'bool', allowedValues: \[true\] \}\)/);
    // Every resource with no other dependency waits for the checks.
    for (const name of ["vmNsg", "dbNsg", "databaseDns", "storage", "publicIp", "dataDisk", "budget"]) {
      const start = bicep.indexOf(`resource ${name} '`);
      expect(start, name).toBeGreaterThan(0);
      const body = bicep.slice(bicep.indexOf("{\n", start));
      expect(body.startsWith("{\n  dependsOn: [inputChecks]\n"), name).toBe(true);
    }
  });

  it("OpenTofu validates the images the same way", () => {
    for (const text of [read("opentofu/modules/aws/variables.tf"), read("opentofu/modules/azure/variables.tf")]) {
      const cms = tfPattern(text, "container_image");
      const caddy = tfPattern(text, "caddy_image");
      expect(cms.test(genuineCms)).toBe(true);
      for (const ok of genuineCaddy) expect(caddy.test(ok)).toBe(true);
      for (const bad of foreign) {
        if (bad !== genuineCms) expect(cms.test(bad), bad).toBe(false);
        if (!genuineCaddy.includes(bad)) expect(caddy.test(bad), bad).toBe(false);
      }
    }
    expect(tfPattern(read("opentofu/modules/aws/variables.tf"), "custom_image_id").test("ami-attacker")).toBe(false);
    expect(tfPattern(read("opentofu/modules/azure/variables.tf"), "custom_image_id").test("/subscriptions/x/providers/Microsoft.Compute/images/y")).toBe(false);
  });
});

describe("review item 2: the OpenTofu database password never reaches state or plans", () => {
  const modules = { aws: tofuAws, azure: tofuAzure };

  it("is an ephemeral value, passed only to write-only arguments", () => {
    for (const [cloud, text] of Object.entries(modules)) {
      expect(text, cloud).not.toMatch(/resource "random_password"/);
      expect(text, cloud).toMatch(/ephemeral "random_password" "database_admin" \{/);
      // Every use of the ephemeral password sits inside a *_wo argument.
      const uses = text.split("\n").filter((l) => l.includes("ephemeral.random_password.database_admin"));
      expect(uses.length, cloud).toBe(2);
    }
    const db = tfResource(tofuAws, "aws_db_instance", "database");
    expect(db).toMatch(/password_wo\s+= ephemeral\.random_password\.database_admin\[0\]\.result/);
    expect(db).toMatch(/password_wo_version\s+= 1/);
    expect(db).not.toMatch(/^\s+password\s+=/m);
    const secret = tfResource(tofuAws, "aws_secretsmanager_secret_version", "database");
    expect(secret).toMatch(/secret_string_wo_version\s+= 1/);
    expect(secret).toMatch(/secret_string_wo = jsonencode\(\{[\s\S]+password\s+= ephemeral\.random_password/);
    expect(secret).not.toMatch(/^\s+secret_string\s+=/m);
    const server = tfResource(tofuAzure, "azurerm_postgresql_flexible_server", "main");
    expect(server).toMatch(/administrator_password_wo\s+= ephemeral\.random_password\.database_admin\[0\]\.result/);
    expect(server).toMatch(/administrator_password_wo_version\s+= 1/);
    expect(server).not.toMatch(/^\s+administrator_password\s+=/m);
    const kv = tfResource(tofuAzure, "azurerm_key_vault_secret", "database");
    expect(kv).toMatch(/value_wo_version\s+= 1/);
    expect(kv).toMatch(/value_wo = jsonencode\(\{[\s\S]+password = ephemeral\.random_password/);
    expect(kv).not.toMatch(/^\s+value\s+=/m);
  });

  it("requires the OpenTofu and provider versions that support it", () => {
    for (const cloud of ["aws", "azure"]) {
      const versions = read(`opentofu/modules/${cloud}/versions.tf`);
      expect(versions).toMatch(/required_version = ">= 1\.11\.0"/);
      expect(versions).toMatch(/hashicorp\/random"\n\s+version = ">= 3\.7, < 4\.0"/);
      expect(read(`opentofu/examples/${cloud}/main.tf`)).toMatch(/required_version = ">= 1\.11\.0"/);
    }
    expect(read("opentofu/modules/azure/versions.tf")).toMatch(/hashicorp\/azurerm"\n\s+version = ">= 4\.30, < 5\.0"/);
  });
});

describe("review item 3: the release gate", () => {
  const digest = "b".repeat(64);
  const releaseFixture = {
    release: true,
    cmsImage: `ghcr.io/polynovea/cms@sha256:${digest}`,
    caddyImage: `caddy@sha256:${digest}`,
    aws: { amis: {} },
    azure: { galleryImages: { x64: "", arm64: "" } },
  };
  const stand = Object.fromEntries(VM_FILES.map((name) => [name, `# ${name}\n`]));
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();

  it("passes a complete release", () => {
    const cfnBaked = renderCfn(cfn, releaseFixture);
    const arm = { parameters: { containerImage: { defaultValue: releaseFixture.cmsImage }, caddyImage: { defaultValue: releaseFixture.caddyImage } } };
    expect(releaseGaps(releaseFixture, renderBootstrap({ ...stand, [RELEASE_KEY]: key }), cfnBaked, arm)).toEqual([]);
  });

  it("fails without the release key, an image digest, or with blank template defaults", () => {
    const cfnBaked = renderCfn(cfn, releaseFixture);
    expect(releaseGaps(releaseFixture, renderBootstrap(stand), cfnBaked, null).join("\n")).toMatch(/no polynovea-release\.pub/);
    expect(releaseGaps({ ...releaseFixture, caddyImage: "" }, renderBootstrap({ ...stand, [RELEASE_KEY]: key }), renderCfn(cfn, { ...releaseFixture, caddyImage: "" }), null).join("\n"))
      .toMatch(/no Caddy image digest[\s\S]+CaddyImage default is blank/);
    expect(releaseGaps(releaseFixture, renderBootstrap({ ...stand, [RELEASE_KEY]: key }), cfn, null).join("\n")).toMatch(/ContainerImage default is blank/);
    expect(releaseGaps({ ...releaseFixture, release: false }, renderBootstrap({ ...stand, [RELEASE_KEY]: key }), cfnBaked, null).join("\n")).toMatch(/"release": false/);
  });

  it("the committed tree is a development build: strict check fails, --not-a-release reports and passes", () => {
    const gate = path.join(DEPLOY, "scripts", "release-templates.mjs");
    const strict = spawnSync(process.execPath, [gate, "--release-check"], { encoding: "utf8" });
    expect(strict.status).toBe(1);
    expect(strict.stderr).toMatch(/NOT READY[\s\S]+no polynovea-release\.pub/);
    const dev = spawnSync(process.execPath, [gate, "--release-check", "--not-a-release"], { encoding: "utf8" });
    expect(dev.status).toBe(0);
    expect(dev.stdout).toMatch(/not a release \(development build\)/);
    expect(read("scripts/validate.sh")).toMatch(/POLYNOVEA_RELEASE:-0\}" = 1[\s\S]+--release-check\n[\s\S]+--release-check --not-a-release/);
  });
});

describe("review item 4: the Azure data disk has a delete lock", () => {
  it("in Bicep and OpenTofu, with the removal documented", () => {
    expect(bicep).toMatch(/resource dataDiskLock 'Microsoft\.Authorization\/locks@[^']+' = \{\n  name: 'polynovea-keep-data-disk'\n  scope: dataDisk\n  properties: \{\n    level: 'CanNotDelete'/);
    const lock = tfResource(tofuAzure, "azurerm_management_lock", "data_disk");
    expect(lock).toMatch(/scope\s+= azurerm_managed_disk\.data\.id/);
    expect(lock).toMatch(/lock_level\s+= "CanNotDelete"/);
    expect(read("azure/README.md")).toMatch(/delete `polynovea-keep-database`, `polynovea-keep-storage` and `polynovea-keep-data-disk`/);
  });
});

describe("review item 5: the Key Vault name is per install", () => {
  it("takes an install ID that's new for each install and passed back for updates", () => {
    expect(bicep).toContain("param installId string = newGuid()");
    expect(bicep).toContain("name: 'pnv-${uniqueString(resourceGroup().id, installId)}'");
    expect(bicep).toContain("output installId string = installId");
    expect(tfResource(tofuAzure, "random_string", "install")).toMatch(/length\s+= 10[\s\S]+upper\s+= false[\s\S]+special\s+= false/);
    expect(read("azure/README.md")).toMatch(/### Updating an install: keep the install ID[\s\S]+installId=<value>/);
    // uniqueString gives 13 lowercase letters and digits; the URI still parses.
    expect(parseSecretRef("https://pnv-abcdefghij012.vault.azure.net/secrets/polynovea-database-admin")).toMatchObject({ kind: "azure" });
  });
});

describe("review item 6: Azure checks its inputs like CloudFormation does", () => {
  it("has a rule for each free-text input, and refuses a deploy with no way in", () => {
    const rules = bicep.slice(bicep.indexOf("var inputRules = {"), bicep.indexOf("}", bicep.indexOf("var inputRules = {")));
    for (const rule of [
      "adminCidrMustBeBlankOrOneIpv4RangeSuchAs203_0_113_7_32: empty(adminCidr) || isIpv4Cidr(adminCidr)",
      "domainMustBeBlankOrALowercaseDomainNameSuchAsCmsExampleCom: empty(domain) || isDomain(domain)",
      "acmeEmailMustBeBlankOrAnEmailAddress: empty(acmeEmail) || isEmail(acmeEmail)",
      "budgetEmailMustBeAnEmailAddress: isEmail(budgetEmail)",
      "setADomainOrAnAdminCidrOtherwiseNobodyCanReachTheSetupWizard: !empty(domain) || !empty(adminCidr)",
    ]) expect(rules).toContain(rule);
    // Values written into the VM's settings file can't carry a line break.
    const isEmail = bicep.slice(bicep.indexOf("func isEmail"), bicep.indexOf("var inputRules"));
    for (const ch of ["n", "r", "t"]) expect(isEmail).toContain(`!contains(text, '${String.fromCharCode(92)}${ch}')`);
    expect(bicep).toMatch(/func isDomain[\s\S]+allIn\(text, 'abcdefghijklmnopqrstuvwxyz0123456789\.-'\)/);
    // The same rules exist in CloudFormation.
    expect(cfn).toMatch(/SomeWayIn:/);
    for (const param of ["Domain", "AcmeEmail", "AdminCidr", "BudgetEmail"]) expect(cfnResource(param)).toMatch(/AllowedPattern: /);
  });
});

describe("review nit 7: the database secret outlives the stack", () => {
  it("is retained on stack deletion and replacement", () => {
    const secret = cfnResource("DatabaseSecret");
    expect(secret).toContain("DeletionPolicy: Retain");
    expect(secret).toContain("UpdateReplacePolicy: Retain");
  });
});

describe("review nit 8: Azure egress like AWS, and OpenTofu emails checked", () => {
  it("lets the Azure VM out to the internet on 443 and 80 only (plus Azure's platform address)", () => {
    for (const rule of ["allow-azure-platform", "allow-https-out", "allow-http-out", "deny-other-internet-outbound", "deny-other-vnet-outbound"]) {
      expect(bicep).toContain(`name: '${rule}'`);
      expect(tofuAzure).toContain(`name                       = "${rule}"`);
    }
    expect(bicep).toMatch(/name: 'deny-other-internet-outbound'\n\s+properties: \{ priority: 4010, direction: 'Outbound', access: 'Deny', protocol: '\*', sourceAddressPrefix: '\*', sourcePortRange: '\*', destinationAddressPrefix: 'Internet'/);
    expect(bicep).toMatch(/name: 'allow-https-out'\n\s+properties: \{ priority: 200, direction: 'Outbound', access: 'Allow', protocol: 'Tcp'[^}]+destinationAddressPrefix: 'Internet', destinationPortRange: '443'/);
  });

  it("refuses an OpenTofu email with a line break or a second address", () => {
    for (const cloud of ["aws", "azure"]) {
      const text = read(`opentofu/modules/${cloud}/variables.tf`);
      const marker = 'var.acme_email == "" || can(regex("';
      const start = text.indexOf(marker) + marker.length;
      const pattern = new RegExp(text.slice(start, text.indexOf('", var.acme_email))', start)).replaceAll("\\\\", "\\"));
      expect(pattern.test("owner@example.com")).toBe(true);
      for (const bad of ["owner@example.com\nPOLYNOVEA_DOMAIN=evil.example", "a@b.c d@e.f", "no-at-sign.example", "a@b@c.d"]) expect(pattern.test(bad), `${cloud}: ${bad}`).toBe(false);
    }
    expect(read("opentofu/modules/azure/variables.tf")).toMatch(/variable "budget_email" \{\n  type = string\n\n  validation \{/);
  });
});

describe("review nits 9 and 10: operator clean-up and costs that outlive the server", () => {
  it("tells OpenTofu operators to remove their vault role and IP access after apply", () => {
    expect(read("opentofu/README.md")).toMatch(/After the first apply on Azure, take your own access away again[\s\S]+operator_ip_ranges = \[\][\s\S]+Key Vault Secrets Officer/);
  });

  it("notes snapshots, retained storage and autogrow next to the cost estimates", () => {
    for (const file of ["README.md", "aws/README.md", "azure/README.md"]) {
      const text = read(file);
      expect(text, file).toMatch(/snapshot|kept/i);
      expect(text, file).toMatch(/grows automatically/);
    }
  });
});

describe("the release gate compares with the signed release manifest", () => {
  const digest = "c".repeat(64);
  const stand = Object.fromEntries(VM_FILES.map((name) => [name, `# ${name}\n`]));
  const key = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
  const keySha = createHash("sha256").update(key).digest("hex");
  const release = { release: true, cmsImage: `ghcr.io/polynovea/cms@sha256:${digest}`, caddyImage: `caddy@sha256:${digest}`, aws: { amis: {} }, azure: { galleryImages: {} } };
  const signed = { schema: 1, image: "ghcr.io/polynovea/cms", digest: `sha256:${digest}`, ref: `ghcr.io/polynovea/cms@sha256:${digest}`, publicKeySha256: keySha };

  it("passes when the CMS image and the embedded key are the signed release's", () => {
    expect(signedReleaseGaps(release, renderBootstrap({ ...stand, [RELEASE_KEY]: key }), signed)).toEqual([]);
  });

  it("fails on another image or another key", () => {
    const bootstrapWithKey = renderBootstrap({ ...stand, [RELEASE_KEY]: key });
    expect(signedReleaseGaps({ ...release, cmsImage: `ghcr.io/polynovea/cms@sha256:${"d".repeat(64)}` }, bootstrapWithKey, signed).join("\n")).toMatch(/isn't the signed release's image/);
    const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(signedReleaseGaps(release, renderBootstrap({ ...stand, [RELEASE_KEY]: otherKey }), signed).join("\n")).toMatch(/isn't the key the release was signed with/);
    expect(signedReleaseGaps(release, renderBootstrap(stand), signed).join("\n")).toMatch(/has no polynovea-release\.pub/);
    expect(signedReleaseGaps(release, bootstrapWithKey, { ...signed, schema: 2 }).join("\n")).toMatch(/schema 2/);
  });

  it("is named apart from the signed manifest, and says where its values come from", () => {
    expect(existsSync(path.join(DEPLOY, "release.json"))).toBe(false);
    expect(JSON.parse(read("release-images.json"))._comment).toMatch(/signed release manifest[\s\S]+Not hand-edited/);
  });
});
