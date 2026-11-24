// Example parameters for a command-line deployment (the "Deploy to Azure" button asks for these in
// the portal instead). Replace the two example values before use.
using 'main.bicep'

param databaseMode = 'managed'
param budgetEmail = 'owner@example.com'
param budgetMonthlyAmount = 70
param adminSshPublicKey = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExampleOnlyReplaceWithYourOwnPublicKeyAAAA example'
param adminCidr = ''
