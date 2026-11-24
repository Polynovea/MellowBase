# Polynovea CMS on AWS: the same resources as deploy/aws/polynovea.yaml, for teams that use OpenTofu.
# The database password is ephemeral: generated during each run and passed only to write-only
# arguments, so it never reaches state or plan files. The root module still MUST enable state encryption
# (see deploy/opentofu/examples/aws).

locals {
  managed          = var.database_mode == "managed"
  tags             = merge({ "polynovea:stack" = var.name }, var.tags)
  ubuntu_parameter = "/aws/service/canonical/ubuntu/server/24.04/stable/current/${var.architecture}/hvm/ebs-gp3/ami-id"
}

data "aws_region" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ssm_parameter" "ubuntu" {
  count = var.custom_image_id == "" ? 1 : 0
  name  = local.ubuntu_parameter
}

# ------------------------------------------------------------------ network (no NAT gateway)

resource "aws_vpc" "main" {
  cidr_block           = "10.20.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = merge(local.tags, { Name = "${var.name}-vpc" })
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-igw" })
}

resource "aws_subnet" "server" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.0.0/24"
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-server" })
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-public" })
}

resource "aws_route" "public_default" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.main.id
}

resource "aws_route_table_association" "server" {
  subnet_id      = aws_subnet.server.id
  route_table_id = aws_route_table.public.id
}

# Database subnets: no route to the internet.
resource "aws_route_table" "database" {
  count  = local.managed ? 1 : 0
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-database" })
}

resource "aws_subnet" "database" {
  count                   = local.managed ? 2 : 0
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.20.${10 + count.index}.0/24"
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = false
  tags                    = merge(local.tags, { Name = "${var.name}-database-${count.index}" })
}

resource "aws_route_table_association" "database" {
  count          = local.managed ? 2 : 0
  subnet_id      = aws_subnet.database[count.index].id
  route_table_id = aws_route_table.database[0].id
}

# Locks down the VPC's default security group: nothing uses it, so it allows nothing.
resource "aws_default_security_group" "default" {
  vpc_id = aws_vpc.main.id
  tags   = merge(local.tags, { Name = "${var.name}-default-unused" })
}

# ------------------------------------------------------------------ security groups

resource "aws_security_group" "server" {
  name        = "${var.name}-server"
  description = "Polynovea server - web in only with a domain, SSH only from admin_cidr, out to HTTPS, HTTP and the database"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${var.name}-server" })
}

# Without a domain nothing answers on 80/443 (the CMS listens on 127.0.0.1 only), so they stay closed.
resource "aws_vpc_security_group_ingress_rule" "server_http" {
  count             = var.domain == "" ? 0 : 1
  security_group_id = aws_security_group.server.id
  description       = "HTTP: Let's Encrypt validation and redirect to HTTPS (Caddy)"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "server_https" {
  count             = var.domain == "" ? 0 : 1
  security_group_id = aws_security_group.server.id
  description       = "Website (HTTPS, Caddy)"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_ingress_rule" "server_ssh" {
  count             = var.admin_cidr == "" ? 0 : 1
  security_group_id = aws_security_group.server.id
  description       = "SSH from the owner's address only"
  ip_protocol       = "tcp"
  from_port         = 22
  to_port           = 22
  cidr_ipv4         = var.admin_cidr
}

resource "aws_vpc_security_group_egress_rule" "server_https" {
  security_group_id = aws_security_group.server.id
  description       = "HTTPS: AWS APIs, image registry, updates"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "server_http" {
  security_group_id = aws_security_group.server.id
  description       = "Ubuntu package mirrors"
  ip_protocol       = "tcp"
  from_port         = 80
  to_port           = 80
  cidr_ipv4         = "0.0.0.0/0"
}

resource "aws_vpc_security_group_egress_rule" "server_database" {
  count                        = local.managed ? 1 : 0
  security_group_id            = aws_security_group.server.id
  description                  = "PostgreSQL to the database only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.database[0].id
}

resource "aws_security_group" "database" {
  count       = local.managed ? 1 : 0
  name        = "${var.name}-database"
  description = "Polynovea database - reachable only from the Polynovea server; no outbound rules"
  vpc_id      = aws_vpc.main.id
  tags        = merge(local.tags, { Name = "${var.name}-database" })
}

resource "aws_vpc_security_group_ingress_rule" "database_from_server" {
  count                        = local.managed ? 1 : 0
  security_group_id            = aws_security_group.database[0].id
  description                  = "PostgreSQL from the Polynovea server only"
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
  referenced_security_group_id = aws_security_group.server.id
}

# ------------------------------------------------------------------ database ("Created for you")

# Ephemeral: generated in each run, sent once to RDS and Secrets Manager through write-only
# arguments, never stored in state or plans. Letters and digits only, so it never needs escaping.
# To set a new password, bump both *_wo_version values below together.
ephemeral "random_password" "database_admin" {
  count   = local.managed ? 1 : 0
  length  = 40
  special = false
}

resource "aws_secretsmanager_secret" "database" {
  count                   = local.managed ? 1 : 0
  name                    = "polynovea/${var.name}/database-admin"
  description             = "Polynovea database admin login. Read once by the setup wizard through the server's role."
  recovery_window_in_days = 7
  tags                    = local.tags
}

resource "aws_db_subnet_group" "database" {
  count       = local.managed ? 1 : 0
  name        = "${var.name}-database"
  description = "Polynovea database subnets (no internet route)"
  subnet_ids  = aws_subnet.database[*].id
  tags        = local.tags
}

resource "aws_db_instance" "database" {
  count                      = local.managed ? 1 : 0
  identifier                 = "${var.name}-database"
  engine                     = "postgres"
  engine_version             = var.postgres_version
  auto_minor_version_upgrade = true
  instance_class             = var.database_instance_class
  db_name                    = "polynovea"
  username                   = "polynovea_admin"
  password_wo                = ephemeral.random_password.database_admin[0].result
  password_wo_version        = 1
  allocated_storage          = var.database_storage_gb
  max_allocated_storage      = 200
  storage_type               = "gp3"
  storage_encrypted          = true
  multi_az                   = false
  publicly_accessible        = false
  db_subnet_group_name       = aws_db_subnet_group.database[0].name
  vpc_security_group_ids     = [aws_security_group.database[0].id]
  backup_retention_period    = 7
  backup_window              = "03:00-04:00"
  deletion_protection        = true
  skip_final_snapshot        = false
  final_snapshot_identifier  = "${var.name}-database-final"
  copy_tags_to_snapshot      = true
  tags                       = merge(local.tags, { Name = "${var.name}-database" })

  # Automatic minor upgrades move the instance past postgres_version; don't "downgrade" it back.
  lifecycle {
    prevent_destroy = true
    ignore_changes  = [engine_version]
  }
}

# The shape the setup wizard reads (lib/setup/database/createdForYou.ts): the same JSON an RDS
# secret attached to its instance holds.
resource "aws_secretsmanager_secret_version" "database" {
  count                    = local.managed ? 1 : 0
  secret_id                = aws_secretsmanager_secret.database[0].id
  secret_string_wo_version = 1
  secret_string_wo = jsonencode({
    engine               = "postgres"
    host                 = aws_db_instance.database[0].address
    port                 = aws_db_instance.database[0].port
    username             = aws_db_instance.database[0].username
    password             = ephemeral.random_password.database_admin[0].result
    dbname               = aws_db_instance.database[0].db_name
    dbInstanceIdentifier = aws_db_instance.database[0].identifier
  })
}

# ------------------------------------------------------------------ bucket

resource "aws_s3_bucket" "main" {
  bucket_prefix = "${var.name}-"
  tags          = merge(local.tags, { Name = "${var.name}-bucket" })

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "main" {
  bucket                  = aws_s3_bucket.main.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "main" {
  bucket = aws_s3_bucket.main.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "main" {
  bucket = aws_s3_bucket.main.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "main" {
  bucket     = aws_s3_bucket.main.id
  depends_on = [aws_s3_bucket_versioning.main]

  rule {
    id     = "keep-deleted-backups-14-days"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 14
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "HttpsOnly"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.main.arn, "${aws_s3_bucket.main.arn}/*"]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "main" {
  bucket     = aws_s3_bucket.main.id
  policy     = data.aws_iam_policy_document.bucket.json
  depends_on = [aws_s3_bucket_public_access_block.main]
}

# ------------------------------------------------------------------ server identity: one secret, one bucket

data "aws_iam_policy_document" "assume_ec2" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "server" {
  name_prefix        = "${var.name}-server-"
  description        = "Polynovea server - reads the one database secret and uses the one bucket. Nothing else."
  assume_role_policy = data.aws_iam_policy_document.assume_ec2.json
  tags               = local.tags
}

data "aws_iam_policy_document" "one_bucket" {
  statement {
    sid       = "ListTheBucket"
    actions   = ["s3:ListBucket", "s3:GetBucketLocation"]
    resources = [aws_s3_bucket.main.arn]
  }
  statement {
    sid       = "ReadWriteTheBucket"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.main.arn}/*"]
  }
}

resource "aws_iam_role_policy" "one_bucket" {
  name   = "one-bucket"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.one_bucket.json
}

data "aws_iam_policy_document" "one_secret" {
  count = local.managed ? 1 : 0
  statement {
    sid       = "ReadTheDatabaseSecret"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.database[0].arn]
  }
}

resource "aws_iam_role_policy" "one_secret" {
  count  = local.managed ? 1 : 0
  name   = "one-secret"
  role   = aws_iam_role.server.id
  policy = data.aws_iam_policy_document.one_secret[0].json
}

resource "aws_iam_instance_profile" "server" {
  name_prefix = "${var.name}-server-"
  role        = aws_iam_role.server.name
}

# ------------------------------------------------------------------ server

resource "aws_ebs_volume" "data" {
  availability_zone = aws_subnet.server.availability_zone
  size              = var.data_volume_gb
  type              = "gp3"
  encrypted         = true
  final_snapshot    = true
  tags              = merge(local.tags, { Name = "${var.name}-data" })

  # Holds settings, uploads and (on-this-server) the database itself.
  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_instance" "server" {
  ami                    = var.custom_image_id != "" ? var.custom_image_id : data.aws_ssm_parameter.ubuntu[0].value
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.server.id
  vpc_security_group_ids = [aws_security_group.server.id]
  iam_instance_profile   = aws_iam_instance_profile.server.name
  key_name               = var.key_pair_name == "" ? null : var.key_pair_name
  ebs_optimized          = true
  monitoring             = false

  # IMDSv2 tokens always required. Hop limit 2, not 1: the release package's bridged container
  # profile runs pgBackRest inside a container, one hop from the instance, and it needs the
  # instance role from IMDS to reach the bucket.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
    instance_metadata_tags      = "disabled"
  }

  root_block_device {
    volume_size           = 20
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  # EC2 user data is limited to 16 KB; cloud-init unpacks gzip by itself.
  user_data_base64 = base64gzip(templatefile("${path.module}/user-data.sh.tftpl", {
    region          = data.aws_region.current.region
    secret_arn      = local.managed ? aws_secretsmanager_secret.database[0].arn : ""
    bucket          = aws_s3_bucket.main.id
    domain          = var.domain
    acme_email      = var.acme_email
    container_image = var.container_image
    caddy_image     = var.caddy_image
    bootstrap       = file("${path.module}/vm-bootstrap.sh")
  }))

  tags = merge(local.tags, { Name = "${var.name}-server" })

  lifecycle {
    ignore_changes = [ami]
  }
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.server.id
}

resource "aws_eip" "server" {
  domain     = "vpc"
  instance   = aws_instance.server.id
  depends_on = [aws_internet_gateway.main]
  tags       = merge(local.tags, { Name = "${var.name}-address" })
}

# ------------------------------------------------------------------ budget alert

resource "aws_budgets_budget" "monthly" {
  name         = "polynovea-${var.name}"
  budget_type  = "COST"
  limit_amount = tostring(var.budget_monthly_usd)
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_email]
  }

  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 100
    threshold_type             = "PERCENTAGE"
    notification_type          = "FORECASTED"
    subscriber_email_addresses = [var.budget_email]
  }
}
