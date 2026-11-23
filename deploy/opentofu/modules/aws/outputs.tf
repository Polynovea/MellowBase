output "setup_address" {
  description = "Where to open the setup wizard. With a domain, first point its A record at public_ip."
  value       = var.domain != "" ? "https://${var.domain}/setup" : "http://localhost:3000/setup, through the ssh_tunnel command"
}

output "public_ip" {
  value = aws_eip.server.public_ip
}

output "database_mode" {
  value = var.database_mode
}

output "database_secret_arn" {
  description = "Set on the server as POLYNOVEA_DB_SECRET_REF. An address, not the secret itself."
  value       = local.managed ? aws_secretsmanager_secret.database[0].arn : null
}

output "database_endpoint" {
  description = "Private; reachable only from the Polynovea server."
  value       = local.managed ? aws_db_instance.database[0].address : null
}

output "bucket_name" {
  description = "Set on the server as POLYNOVEA_BACKUP_BUCKET; the setup wizard suggests it for \"On this server\" backups."
  value       = aws_s3_bucket.main.id
}

output "bucket_region" {
  value = data.aws_region.current.region
}

output "server_role_arn" {
  value = aws_iam_role.server.arn
}

output "ssh_tunnel" {
  description = "SSH from admin_cidr with your key pair. Without a domain this is also the route into the setup wizard."
  value       = var.admin_cidr == "" ? null : (var.domain != "" ? "ssh ubuntu@${aws_eip.server.public_ip}" : "ssh -L 3000:127.0.0.1:3000 ubuntu@${aws_eip.server.public_ip}")
}
