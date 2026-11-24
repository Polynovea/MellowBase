// Polynovea CMS on one Azure VM in your own subscription, with Azure Database for PostgreSQL
// Flexible Server 16 (or PostgreSQL on the VM itself), a Blob container, a Key Vault, a budget alert
// and a managed identity that can read one secret and use one container.
//
// Expected monthly cost, estimated from Azure pay-as-you-go list prices for East US in November 2026,
// before tax, with light traffic: about US$56 with databaseMode = 'managed' (Standard_B2s VM,
// Burstable B1ms database with 32 GB, 2 x 32 GB Standard SSD disks, static public IP, private DNS
// zone) or about US$39 with databaseMode = 'on-this-server'. Other regions and heavy traffic cost
// more; your Azure bill is what counts.

metadata description = 'Polynovea CMS: one VM, PostgreSQL Flexible Server 16 or on-server PostgreSQL, Blob backups, Key Vault, budget alert. About US$56/month managed or US$39/month on-this-server (East US list prices, November 2026).'

targetScope = 'resourceGroup'

// ---------------------------------------------------------------- parameters

@description('Where the database runs. managed = Azure Database for PostgreSQL Flexible Server, found by the setup wizard by itself ("Created for you"). on-this-server = PostgreSQL on the VM\'s data disk, backed up to the Blob container.')
@allowed(['managed', 'on-this-server'])
param databaseMode string = 'managed'

@description('Email for the budget alert: Azure writes when spending passes 80% of the budget, or is forecast to pass 100%.')
param budgetEmail string

@description('Monthly budget for this resource group, in the subscription\'s billing currency.')
@minValue(1)
param budgetMonthlyAmount int = 70

@description('Your SSH public key (one line starting with ssh-ed25519 or ssh-rsa). Azure requires one for a Linux VM; it is a public key, not a secret.')
param adminSshPublicKey string

@description('Your domain for the site, for example cms.example.com. With a domain the VM gets a free HTTPS certificate (Let\'s Encrypt) once the domain\'s A record points at the publicIp output, and setup is at https://<domain>/setup. Without one, ports 80 and 443 stay closed and setup goes through the SSH tunnel, which needs adminCidr.')
param domain string = ''

@description('Optional. Let\'s Encrypt may email this address about the certificate.')
param acmeEmail string = ''

@description('Leave blank for no SSH access at all. Set it to your own address (ending /32) to allow SSH from that address only. Needed for the SSH-tunnel route into the setup wizard when there is no domain.')
param adminCidr string = ''

@description('VM size. Standard_B2s (2 vCPU, 4 GB) suits both modes.')
param vmSize string = 'Standard_B2s'

@description('Processor type. Must match vmSize: x64 for B2s and other Intel/AMD sizes, arm64 for Arm sizes such as Standard_B2pls_v2.')
@allowed(['x64', 'arm64'])
param architecture string = 'x64'

@description('Size of the separate data disk mounted at /var/lib/polynovea (settings, uploads, and the database when it runs on the VM).')
@minValue(16)
@maxValue(4095)
param dataDiskGb int = 32

@description('Database size (managed only). Burstable sizes are the cheapest.')
@allowed(['Standard_B1ms', 'Standard_B2s', 'Standard_B2ms'])
param databaseSku string = 'Standard_B1ms'

@description('Database storage in GB (managed only). It grows automatically.')
@allowed([32, 64, 128, 256])
param databaseStorageGb int = 32

// Names normally start with 'polynovea'. The default keeps the names every earlier version of this
// template gave; the storage account takes the prefix too, so it is letters and digits only, and at
// most 11 characters (24 with the 13-character suffix).
@description('Start of the resource names. Leave as it is unless you want other names (for example mellowbase); set it on the first deployment and keep it for updates, because a new prefix creates new resources. 3 to 11 lowercase letters and digits, starting with a letter.')
@minLength(3)
@maxLength(11)
param namePrefix string = 'polynovea'

@description('Every resource that takes tags gets Project=<this value>, so this install\'s costs can be found in Cost Management. The budget already counts only this resource group.')
@minLength(1)
@maxLength(64)
param projectTag string = 'MellowBase'

// Images come only from the release (deploy/release-images.json). The checks below refuse anything else, so a
// "Deploy to Azure" link can't swap in someone else's image: the CMS only from ghcr.io/polynovea/,
// the proxy only Caddy's official image, both pinned by digest. The server checks the CMS image's
// signature again before every start.
@description('Set by the release: the Polynovea CMS image, ghcr.io/polynovea/<name>@sha256:<digest>. Leave as it is.')
param containerImage string = loadJsonContent('../release-images.json').cmsImage

@description('Set by the release: Caddy\'s official image, caddy@sha256:<digest>. Leave as it is.')
param caddyImage string = loadJsonContent('../release-images.json').caddyImage

@description('Location for all resources.')
param location string = resourceGroup().location

@description('First day of the budget period. Leave as it is.')
param budgetStartDate string = utcNow('yyyy-MM-01')

// Key Vault keeps a deleted vault's name for 90 days (purge protection), so a name fixed by the
// resource group would block a fresh install into the same group. The vault name also takes this
// install ID, generated on the first deployment. To UPDATE an install, pass the installId output of
// the first deployment back in (the button's "Install Id" field, or --parameters installId=...):
// a new ID means a new vault, which an existing VM can't use.
@description('Leave as it is for a new install. To update an existing install, enter the installId output of its first deployment.')
param installId string = newGuid()

// The database admin password: generated fresh by Azure Resource Manager at deployment time. A
// @secure() parameter is never shown in the portal or kept in the deployment history. newGuid() is
// 122 random bits; the "P" prefix plus the GUID's hyphens and its fixed version digit "4" always meet
// Flexible Server's rule of three character classes out of four. Never uniqueString(): it is
// deterministic, so anyone who knows the resource group ID could recompute it.
#disable-next-line secure-parameter-default
@secure()
@description('Leave as it is: a new random password is generated for every deployment and written straight into Key Vault.')
param databaseAdminPassword string = 'P${newGuid()}'

// ---------------------------------------------------------------- names and constants

var managed = databaseMode == 'managed'
var hasAdminCidr = !empty(adminCidr)
var hasDomain = !empty(domain)
// The release's published Polynovea gallery image for this processor; blank = Ubuntu 24.04 LTS.
var galleryImage = loadJsonContent('../release-images.json').azure.galleryImages[architecture]
var suffix = uniqueString(resourceGroup().id) // 13 characters, for names only (never for secrets)
var prefix = namePrefix
var tags = { Project: projectTag }
var vnetCidr = '10.30.0.0/16'
var vmSubnetCidr = '10.30.0.0/24'
var dbSubnetCidr = '10.30.1.0/24'
var databaseAdminUser = 'polynovea_admin'
var databaseName = 'polynovea'
var containerName = 'polynovea'
var secretName = 'polynovea-database-admin'

// Built-in role IDs (the same in every Azure tenant).
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// ---------------------------------------------------------------- input checks
// Bicep can't put a pattern on a parameter, so each rule is computed here and handed to a tiny nested
// deployment whose parameters accept only true. A broken rule fails that deployment, naming the rule,
// before any other resource is created (everything depends on it).
//
// Written with plain variables and single-level lambdas, not user-defined functions: functions make
// the compiled template ARM language version 2.0, which policy scanners (checkov) can't read. Strings
// are compared, never converted, so a bad value can't stop a check from running.
var hex = '0123456789abcdef'

// The CMS image: ghcr.io/polynovea/<name>@sha256:<64 hex>.
var cmsParts = split(containerImage, '@sha256:')
var cmsName = first(cmsParts)
var cmsDigest = last(cmsParts)
var containerImageOk = length(cmsParts) == 2 && startsWith(cmsName, 'ghcr.io/polynovea/') && length(cmsName) > 18 && empty(filter(range(0, length(cmsName)), i => !contains('abcdefghijklmnopqrstuvwxyz0123456789._/-', substring(cmsName, i, 1)))) && length(cmsDigest) == 64 && empty(filter(range(0, length(cmsDigest)), i => !contains(hex, substring(cmsDigest, i, 1))))

// The proxy: Caddy's official image, caddy@sha256:<64 hex>.
var caddyParts = split(caddyImage, '@sha256:')
var caddyDigest = last(caddyParts)
var caddyImageOk = length(caddyParts) == 2 && contains(['caddy', 'docker.io/library/caddy'], first(caddyParts)) && length(caddyDigest) == 64 && empty(filter(range(0, length(caddyDigest)), i => !contains(hex, substring(caddyDigest, i, 1))))

// One IPv4 range such as 203.0.113.7/32: digits and dots, four octets of at most '255', prefix at most '32'.
var cidrParts = split(adminCidr, '/')
var cidrAddress = first(cidrParts)
var cidrPrefix = last(cidrParts)
var cidrOctets = split(cidrAddress, '.')
var adminCidrOk = length(cidrParts) == 2 && empty(filter(range(0, length(cidrAddress)), i => !contains('0123456789.', substring(cidrAddress, i, 1)))) && length(cidrOctets) == 4 && empty(filter(cidrOctets, o => empty(o) || length(o) > 3 || (length(o) == 3 && o > '255'))) && !empty(cidrPrefix) && length(cidrPrefix) <= 2 && empty(filter(range(0, length(cidrPrefix)), i => !contains('0123456789', substring(cidrPrefix, i, 1)))) && (length(cidrPrefix) < 2 || cidrPrefix <= '32')

// A lowercase domain name: letters, digits, dots and hyphens, at least one dot, no empty label, no
// label starting or ending with a hyphen.
var domainOk = length(domain) <= 253 && contains(domain, '.') && empty(filter(range(0, length(domain)), i => !contains('abcdefghijklmnopqrstuvwxyz0123456789.-', substring(domain, i, 1)))) && empty(filter(split(domain, '.'), label => empty(label) || startsWith(label, '-') || endsWith(label, '-')))

// Email addresses with no spaces or line breaks (they're written into the VM's settings file, so a
// line break could add a setting).
var acmeEmailOk = length(split(acmeEmail, '@')) == 2 && !empty(first(split(acmeEmail, '@'))) && contains(last(split(acmeEmail, '@')), '.') && !contains(acmeEmail, ' ') && !contains(acmeEmail, '\n') && !contains(acmeEmail, '\r') && !contains(acmeEmail, '\t')
var budgetEmailOk = length(split(budgetEmail, '@')) == 2 && !empty(first(split(budgetEmail, '@'))) && contains(last(split(budgetEmail, '@')), '.') && !contains(budgetEmail, ' ') && !contains(budgetEmail, '\n') && !contains(budgetEmail, '\r') && !contains(budgetEmail, '\t')

// The name prefix (length is checked by its decorators): a letter, then letters and digits.
var namePrefixOk = contains('abcdefghijklmnopqrstuvwxyz', substring(namePrefix, 0, 1)) && empty(filter(range(0, length(namePrefix)), i => !contains('abcdefghijklmnopqrstuvwxyz0123456789', substring(namePrefix, i, 1))))

var inputRules = {
  namePrefixMustBeLowercaseLettersAndDigitsStartingWithALetter: namePrefixOk
  containerImageMustBeThePolynoveaImageFromGhcrPinnedByDigest: empty(containerImage) || containerImageOk
  caddyImageMustBeCaddysOfficialImagePinnedByDigest: empty(caddyImage) || caddyImageOk
  adminCidrMustBeBlankOrOneIpv4RangeSuchAs203_0_113_7_32: empty(adminCidr) || adminCidrOk
  domainMustBeBlankOrALowercaseDomainNameSuchAsCmsExampleCom: empty(domain) || domainOk
  acmeEmailMustBeBlankOrAnEmailAddress: empty(acmeEmail) || acmeEmailOk
  budgetEmailMustBeAnEmailAddress: budgetEmailOk
  setADomainOrAnAdminCidrOtherwiseNobodyCanReachTheSetupWizard: !empty(domain) || !empty(adminCidr)
}

resource inputChecks 'Microsoft.Resources/deployments@2022-09-01' = {
  name: 'polynovea-input-checks'
  tags: tags
  properties: {
    mode: 'Incremental'
    expressionEvaluationOptions: { scope: 'inner' }
    // The nested template can't see this template's variables, so its parameter list is written out
    // here, one per rule in inputRules (a unit test keeps the two in step).
    template: {
      '$schema': 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#'
      contentVersion: '1.0.0.0'
      parameters: {
        namePrefixMustBeLowercaseLettersAndDigitsStartingWithALetter: { type: 'bool', allowedValues: [true] }
        containerImageMustBeThePolynoveaImageFromGhcrPinnedByDigest: { type: 'bool', allowedValues: [true] }
        caddyImageMustBeCaddysOfficialImagePinnedByDigest: { type: 'bool', allowedValues: [true] }
        adminCidrMustBeBlankOrOneIpv4RangeSuchAs203_0_113_7_32: { type: 'bool', allowedValues: [true] }
        domainMustBeBlankOrALowercaseDomainNameSuchAsCmsExampleCom: { type: 'bool', allowedValues: [true] }
        acmeEmailMustBeBlankOrAnEmailAddress: { type: 'bool', allowedValues: [true] }
        budgetEmailMustBeAnEmailAddress: { type: 'bool', allowedValues: [true] }
        setADomainOrAnAdminCidrOtherwiseNobodyCanReachTheSetupWizard: { type: 'bool', allowedValues: [true] }
      }
      resources: []
    }
    parameters: toObject(items(inputRules), rule => rule.key, rule => { value: rule.value })
  }
}

var ubuntuImage = {
  publisher: 'Canonical'
  offer: 'ubuntu-24_04-lts'
  sku: architecture == 'arm64' ? 'server-arm64' : 'server'
  version: 'latest'
}

// ---------------------------------------------------------------- network

resource vmNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = {
  dependsOn: [inputChecks]
  name: '${prefix}-vm-nsg'
  location: location
  tags: tags
  properties: {
    // Without a domain nothing answers on 80/443 (the CMS listens on 127.0.0.1 only), so they stay closed.
    securityRules: concat(
      hasDomain
        ? [
            {
              name: 'allow-http'
              properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: 'Internet', sourcePortRange: '*', destinationAddressPrefix: vmSubnetCidr, destinationPortRange: '80', description: 'HTTP: Let\'s Encrypt validation and redirect to HTTPS (Caddy)' }
            }
            {
              name: 'allow-https'
              properties: { priority: 110, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: 'Internet', sourcePortRange: '*', destinationAddressPrefix: vmSubnetCidr, destinationPortRange: '443', description: 'Website (HTTPS, Caddy)' }
            }
          ]
        : [],
      hasAdminCidr
        ? [
            {
              name: 'allow-ssh-from-owner'
              properties: { priority: 120, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: adminCidr, sourcePortRange: '*', destinationAddressPrefix: vmSubnetCidr, destinationPortRange: '22', description: 'SSH from the owner\'s address only' }
            }
          ]
        : [],
      [
        {
          name: 'deny-other-inbound'
          properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*', description: 'Nothing else in, including from inside the virtual network' }
        }
      ],
      managed
        ? [
            {
              name: 'allow-postgres-to-database'
              properties: { priority: 100, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: vmSubnetCidr, sourcePortRange: '*', destinationAddressPrefix: dbSubnetCidr, destinationPortRange: '5432', description: 'PostgreSQL to the database only' }
            }
          ]
        : [],
      [
        {
          name: 'allow-azure-platform'
          properties: { priority: 150, direction: 'Outbound', access: 'Allow', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '168.63.129.16', destinationPortRange: '*', description: 'Azure platform address: DNS and the VM agent' }
        }
        {
          name: 'allow-https-out'
          properties: { priority: 200, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: 'Internet', destinationPortRange: '443', description: 'HTTPS: Azure APIs, image registry, updates' }
        }
        {
          name: 'allow-http-out'
          properties: { priority: 210, direction: 'Outbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: 'Internet', destinationPortRange: '80', description: 'Ubuntu package mirrors' }
        }
        {
          name: 'deny-other-internet-outbound'
          properties: { priority: 4010, direction: 'Outbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: 'Internet', destinationPortRange: '*', description: 'Out to the internet only on 443 and 80, as on AWS' }
        }
        {
          name: 'deny-other-vnet-outbound'
          properties: { priority: 4000, direction: 'Outbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: 'VirtualNetwork', destinationPortRange: '*', description: 'Inside the virtual network, the VM reaches the database and nothing else' }
        }
      ]
    )
  }
}

resource dbNsg 'Microsoft.Network/networkSecurityGroups@2024-05-01' = if (managed) {
  dependsOn: [inputChecks]
  name: '${prefix}-db-nsg'
  location: location
  tags: tags
  properties: {
    securityRules: [
      {
        name: 'allow-postgres-from-vm'
        properties: { priority: 100, direction: 'Inbound', access: 'Allow', protocol: 'Tcp', sourceAddressPrefix: vmSubnetCidr, sourcePortRange: '*', destinationAddressPrefix: dbSubnetCidr, destinationPortRange: '5432', description: 'PostgreSQL from the Polynovea VM only' }
      }
      {
        name: 'deny-other-inbound'
        properties: { priority: 4000, direction: 'Inbound', access: 'Deny', protocol: '*', sourceAddressPrefix: '*', sourcePortRange: '*', destinationAddressPrefix: '*', destinationPortRange: '*', description: 'Nothing else reaches the database' }
      }
    ]
  }
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: [vnetCidr] }
    subnets: concat(
      [
        {
          name: 'vm'
          properties: {
            addressPrefix: vmSubnetCidr
            networkSecurityGroup: { id: vmNsg.id }
            // Lets the Key Vault and storage firewalls admit this subnet and nothing else.
            serviceEndpoints: [{ service: 'Microsoft.KeyVault' }, { service: 'Microsoft.Storage' }]
          }
        }
      ],
      managed
        ? [
            {
              name: 'database'
              properties: {
                addressPrefix: dbSubnetCidr
                networkSecurityGroup: { id: dbNsg.id }
                delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }]
              }
            }
          ]
        : []
    )
  }
}

resource vmSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = {
  parent: vnet
  name: 'vm'
}

resource dbSubnet 'Microsoft.Network/virtualNetworks/subnets@2024-05-01' existing = if (managed) {
  parent: vnet
  name: 'database'
}

// ---------------------------------------------------------------- database ("Created for you")

resource databaseDns 'Microsoft.Network/privateDnsZones@2024-06-01' = if (managed) {
  dependsOn: [inputChecks]
  name: '${prefix}-${suffix}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource databaseDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (managed) {
  parent: databaseDns
  name: 'polynovea-vnet'
  location: 'global'
  tags: tags
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (managed) {
  name: '${prefix}-db-${suffix}'
  location: location
  tags: tags
  sku: { name: databaseSku, tier: 'Burstable' }
  properties: {
    version: '16'
    administratorLogin: databaseAdminUser
    administratorLoginPassword: databaseAdminPassword
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
    storage: { storageSizeGB: databaseStorageGb, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      publicNetworkAccess: 'Disabled'
      delegatedSubnetResourceId: dbSubnet.id
      privateDnsZoneArmResourceId: databaseDns.id
    }
  }
  dependsOn: [databaseDnsLink]
}

resource databaseTls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = if (managed) {
  parent: database
  name: 'require_secure_transport'
  properties: { value: 'on', source: 'user-override' }
}

resource databaseDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (managed) {
  parent: database
  name: databaseName
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [databaseTls]
}

// Flexible Server has no deletion-protection flag; a delete lock is Azure's equivalent.
resource databaseLock 'Microsoft.Authorization/locks@2020-05-01' = if (managed) {
  name: 'polynovea-keep-database'
  scope: database
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds the Polynovea CMS content. Remove this lock deliberately before deleting the database.'
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = if (managed) {
  name: 'pnv-${uniqueString(resourceGroup().id, installId)}'
  location: location
  tags: tags
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      bypass: 'AzureServices'
      virtualNetworkRules: [{ id: vmSubnet.id }]
    }
  }
}

// The admin login in the shape the setup wizard reads (lib/setup/database/createdForYou.ts).
resource databaseSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = if (managed) {
  parent: vault
  name: secretName
  tags: tags
  properties: {
    contentType: 'application/json'
    attributes: { enabled: true }
    value: string({
      engine: 'postgres'
      host: database.properties.fullyQualifiedDomainName
      port: 5432
      username: databaseAdminUser
      password: databaseAdminPassword
      dbname: databaseName
    })
  }
  dependsOn: [databaseDb]
}

// ---------------------------------------------------------------- storage: one container

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  dependsOn: [inputChecks]
  name: '${prefix}${suffix}'
  location: location
  tags: tags
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    accessTier: 'Hot'
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    publicNetworkAccess: 'Enabled'
    networkAcls: {
      defaultAction: 'Deny'
      // Nothing needs it: the VM comes in through its subnet, the container is made through Azure Resource Manager.
      bypass: 'None'
      virtualNetworkRules: [{ id: vmSubnet.id, action: 'Allow' }]
    }
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true
      services: { blob: { enabled: true, keyType: 'Account' }, file: { enabled: true, keyType: 'Account' } }
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 14 }
    containerDeleteRetentionPolicy: { enabled: true, days: 14 }
  }
}

resource container 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: containerName
  properties: { publicAccess: 'None' }
}

resource storageLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'polynovea-keep-storage'
  scope: storage
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds Polynovea backups and files. Remove this lock deliberately before deleting the storage account.'
  }
}

// ---------------------------------------------------------------- the VM

resource publicIp 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  dependsOn: [inputChecks]
  name: '${prefix}-ip'
  location: location
  tags: tags
  sku: { name: 'Standard', tier: 'Regional' }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: { domainNameLabel: '${prefix}-${suffix}' }
  }
}

resource nic 'Microsoft.Network/networkInterfaces@2024-05-01' = {
  name: '${prefix}-nic'
  location: location
  tags: tags
  properties: {
    ipConfigurations: [
      {
        name: 'primary'
        properties: {
          privateIPAllocationMethod: 'Dynamic'
          subnet: { id: vmSubnet.id }
          publicIPAddress: { id: publicIp.id }
        }
      }
    ]
  }
}

// A separate disk for /var/lib/polynovea. It is detached, not deleted, if the VM is deleted.
resource dataDisk 'Microsoft.Compute/disks@2024-03-02' = {
  dependsOn: [inputChecks]
  name: '${prefix}-data'
  location: location
  tags: tags
  sku: { name: 'StandardSSD_LRS' }
  properties: {
    creationData: { createOption: 'Empty' }
    diskSizeGB: dataDiskGb
    publicNetworkAccess: 'Disabled'
    networkAccessPolicy: 'DenyAll'
  }
}

// The data disk holds settings and uploads, and with databaseMode = 'on-this-server' the only live
// copy of the database. A delete lock stops it being removed by accident (the VM itself can still be
// deleted: the disk is detached, not deleted). Remove the lock deliberately first (see the README).
resource dataDiskLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: 'polynovea-keep-data-disk'
  scope: dataDisk
  properties: {
    level: 'CanNotDelete'
    notes: 'Holds the Polynovea data folder and, on-this-server, the database. Remove this lock deliberately before deleting the disk.'
  }
}

// Custom data is readable on the VM and kept by cloud-init, so it holds no secrets: only the secret's
// URI, the storage names, the domain and the image digests. The keys are the release package's
// contract; the release package sets HOSTNAME, PORT, POLYNOVEA_TRUSTED_PROXIES and POLYNOVEA_CONFIG_DIR.
var settings = join(
  [
    '# Written by the Polynovea Azure template. Non-secret values only.'
    managed
      ? 'POLYNOVEA_DB_SECRET_REF=${databaseSecret.properties.secretUri}'
      : '# POLYNOVEA_DB_SECRET_REF is not set: the database runs on this server.'
    'POLYNOVEA_BACKUP_ACCOUNT=${storage.name}'
    'POLYNOVEA_BACKUP_CONTAINER=${containerName}'
    hasDomain ? 'POLYNOVEA_DOMAIN=${domain}' : '# POLYNOVEA_DOMAIN is not set: setup goes through the SSH tunnel.'
    empty(acmeEmail) ? '# POLYNOVEA_ACME_EMAIL is not set.' : 'POLYNOVEA_ACME_EMAIL=${acmeEmail}'
    empty(containerImage) ? '# POLYNOVEA_IMAGE_REF: the server image\'s own.' : 'POLYNOVEA_IMAGE_REF=${containerImage}'
    empty(caddyImage) ? '# POLYNOVEA_CADDY_IMAGE_REF: the server image\'s own.' : 'POLYNOVEA_CADDY_IMAGE_REF=${caddyImage}'
  ],
  '\n'
)

// The release package's first-boot script, generated from its VM files by
// deploy/scripts/sync-vm-bootstrap.mjs. It runs as its own systemd unit, not inside cloud-init,
// because it waits for cloud-init to finish.
var cloudInit = join(
  [
    '#cloud-config'
    'write_files:'
    '  - path: /etc/polynovea/polynovea.env'
    '    permissions: "0640"'
    '    encoding: b64'
    '    content: ${base64('${settings}\n')}'
    '  - path: /usr/local/sbin/polynovea-bootstrap'
    '    permissions: "0750"'
    '    encoding: b64'
    '    content: ${base64(loadTextContent('../scripts/vm-bootstrap.sh'))}'
    'runcmd:'
    '  - [systemd-run, --unit=polynovea-bootstrap, "--description=Polynovea first boot", /bin/sh, /usr/local/sbin/polynovea-bootstrap, azure]'
  ],
  '\n'
)

resource vm 'Microsoft.Compute/virtualMachines@2024-07-01' = {
  name: '${prefix}-vm'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {
    hardwareProfile: { vmSize: vmSize }
    // Trusted Launch (secure boot and a virtual TPM) on x64, with the Ubuntu marketplace image or the
    // release's gallery image (its definition is created with SecurityType=TrustedLaunchSupported).
    // Azure's Arm64 sizes don't offer it.
    securityProfile: architecture == 'x64'
      ? {
          securityType: 'TrustedLaunch'
          uefiSettings: { secureBootEnabled: true, vTpmEnabled: true }
        }
      : null
    osProfile: {
      computerName: 'polynovea'
      adminUsername: 'polynovea'
      customData: base64(cloudInit)
      linuxConfiguration: {
        disablePasswordAuthentication: true
        ssh: { publicKeys: [{ path: '/home/polynovea/.ssh/authorized_keys', keyData: adminSshPublicKey }] }
        provisionVMAgent: true
        patchSettings: { patchMode: 'ImageDefault', assessmentMode: 'ImageDefault' }
      }
      allowExtensionOperations: false
    }
    storageProfile: {
      // The release's community gallery image, by its public name, or else Ubuntu 24.04 LTS. No
      // parameter can name another image.
      imageReference: empty(galleryImage) ? ubuntuImage : { communityGalleryImageId: galleryImage }
      osDisk: {
        name: '${prefix}-os'
        createOption: 'FromImage'
        diskSizeGB: 30
        deleteOption: 'Delete'
        managedDisk: { storageAccountType: 'StandardSSD_LRS' }
      }
      dataDisks: [
        {
          lun: 0
          createOption: 'Attach'
          deleteOption: 'Detach'
          managedDisk: { id: dataDisk.id }
        }
      ]
    }
    networkProfile: {
      networkInterfaces: [{ id: nic.id, properties: { deleteOption: 'Delete' } }]
    }
    // Boot diagnostics with Azure-managed storage: the serial console helps when the VM will not boot.
    diagnosticsProfile: { bootDiagnostics: { enabled: true } }
  }
}

// ---------------------------------------------------------------- identity: one secret, one container

resource secretReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (managed) {
  name: guid(databaseSecret.id, vm.id, keyVaultSecretsUserRoleId)
  scope: databaseSecret
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'The Polynovea VM reads this one secret: the database admin login, used once by the setup wizard.'
  }
}

resource containerWriter 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(container.id, vm.id, storageBlobDataContributorRoleId)
  scope: container
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', storageBlobDataContributorRoleId)
    principalId: vm.identity.principalId
    principalType: 'ServicePrincipal'
    description: 'The Polynovea VM uses this one container: backups and files.'
  }
}

// ---------------------------------------------------------------- budget alert
// Deployed by this resource-group template with no scope of its own, the budget is the resource
// group's: it counts this install's costs only, even in a subscription shared with other work.

resource budget 'Microsoft.Consumption/budgets@2023-11-01' = {
  dependsOn: [inputChecks]
  name: 'polynovea-${suffix}'
  properties: {
    category: 'Cost'
    amount: budgetMonthlyAmount
    timeGrain: 'Monthly'
    timePeriod: { startDate: budgetStartDate }
    notifications: {
      actual80: { enabled: true, operator: 'GreaterThan', threshold: 80, thresholdType: 'Actual', contactEmails: [budgetEmail] }
      forecast100: { enabled: true, operator: 'GreaterThan', threshold: 100, thresholdType: 'Forecasted', contactEmails: [budgetEmail] }
    }
  }
}

// ---------------------------------------------------------------- outputs

@description('Where to open the setup wizard. With a domain, first point its A record at publicIp. The setup code is in the VM\'s log (see the README).')
output setupAddress string = hasDomain
  ? 'https://${domain}/setup (after the domain\'s A record points at ${publicIp.properties.ipAddress})'
  : 'http://localhost:3000/setup, through the sshTunnel command'

@description('Where to find the one-time setup code the wizard asks for. It is shown only until setup is finished, works once and expires after an hour. Anyone in this subscription who can read the VM\'s serial console can see it during that time.')
output setupCode string = 'Azure portal > Virtual machines > ${prefix}-vm > Help > Serial console (or Help > Boot diagnostics > Serial log). Look for the line with "Setup code" (it appears a few minutes after the VM starts; refresh if it isn\'t there yet).'

@description('SSH from adminCidr with your key. Without a domain this is also the route into the setup wizard.')
output sshTunnel string = !hasAdminCidr
  ? ''
  : hasDomain
      ? 'ssh polynovea@${publicIp.properties.ipAddress}'
      : 'ssh -L 3000:127.0.0.1:3000 polynovea@${publicIp.properties.ipAddress}'

@description('The VM\'s fixed public address. Point your domain\'s A record here.')
output publicIp string = publicIp.properties.ipAddress

output databaseMode string = databaseMode

@description('Set on the VM as POLYNOVEA_DB_SECRET_REF. An address, not the secret itself.')
output databaseSecretRef string = managed ? databaseSecret.properties.secretUri : ''

@description('Private; reachable only from the Polynovea VM.')
output databaseHost string = managed ? database.properties.fullyQualifiedDomainName : ''

@description('Set on the VM as POLYNOVEA_BACKUP_ACCOUNT and POLYNOVEA_BACKUP_CONTAINER; the setup wizard suggests them for "On this server" backups.')
output storageAccountName string = storage.name

output containerName string = containerName

@description('Keep this. Pass it back as installId whenever you update or redeploy this install.')
output installId string = installId
