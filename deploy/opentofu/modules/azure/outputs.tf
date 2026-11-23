output "setup_address" {
  description = "Where to open the setup wizard. With a domain, first point its A record at public_ip."
  value       = var.domain != "" ? "https://${var.domain}/setup" : "http://localhost:3000/setup, through the ssh_tunnel command"
}

output "public_ip" {
  value = azurerm_public_ip.main.ip_address
}

output "database_mode" {
  value = var.database_mode
}

output "database_secret_ref" {
  description = "Set on the VM as POLYNOVEA_DB_SECRET_REF. An address, not the secret itself."
  value       = local.managed ? azurerm_key_vault_secret.database[0].versionless_id : null
}

output "database_host" {
  description = "Private; reachable only from the Polynovea VM."
  value       = local.managed ? azurerm_postgresql_flexible_server.main[0].fqdn : null
}

output "storage_account_name" {
  description = "Set on the VM as POLYNOVEA_BACKUP_ACCOUNT; the setup wizard suggests it for \"On this server\" backups."
  value       = azurerm_storage_account.main.name
}

output "container_name" {
  value = local.container_name
}

output "ssh_tunnel" {
  description = "SSH from admin_cidr with your key. Without a domain this is also the route into the setup wizard."
  value       = var.admin_cidr == "" ? null : (var.domain != "" ? "ssh polynovea@${azurerm_public_ip.main.ip_address}" : "ssh -L 3000:127.0.0.1:3000 polynovea@${azurerm_public_ip.main.ip_address}")
}
