# Polynovea CMS AMI: Ubuntu 24.04 LTS + Docker + the signed CMS image, IMDSv2 only.
# Build from a release machine with AWS credentials (never from GitHub Actions):
#   packer init deploy/packer
#   packer build -only='polynovea-aws.*' -var-file=release.pkrvars.hcl deploy/packer
# See docs/self-hosting/vm-images.md.

packer {
  required_version = ">= 1.11.0"
  required_plugins {
    amazon = {
      source  = "github.com/hashicorp/amazon"
      version = "= 1.3.9"
    }
    azure = {
      source  = "github.com/hashicorp/azure"
      version = "= 2.3.3"
    }
  }
}

locals {
  aws_instance_type = var.aws_instance_type != "" ? var.aws_instance_type : (var.arch == "arm64" ? "t4g.small" : "t3.small")
}

source "amazon-ebs" "polynovea" {
  region        = var.aws_region
  instance_type = local.aws_instance_type
  ami_name      = "${local.image_name}-{{timestamp}}"
  ami_regions   = var.aws_ami_regions
  ssh_username  = "ubuntu"

  # Canonical's official Ubuntu 24.04 LTS images only.
  source_ami_filter {
    filters = {
      name                = "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-${var.arch}-server-*"
      virtualization-type = "hvm"
      root-device-type    = "ebs"
    }
    owners      = ["099720108477"]
    most_recent = true
  }

  # IMDSv2 only, on the build instance and (imds_support) on every instance launched from this AMI.
  # A hop limit of 2 lets the CMS container reach the instance role (pgBackRest's S3 backups).
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 2
  }
  imds_support = "v2.0"

  launch_block_device_mappings {
    device_name           = "/dev/sda1"
    volume_size           = 16
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = {
    Name                   = local.image_name
    "polynovea:release-id" = var.release_id
    "polynovea:image-ref"  = var.image_ref
  }
  run_tags = {
    Name               = "packer-${local.image_name}"
    "polynovea:packer" = "true"
  }
}

build {
  name    = "polynovea-aws"
  sources = ["source.amazon-ebs.polynovea"]

  provisioner "file" {
    source      = "${path.root}/files/"
    destination = "/tmp/polynovea-files"
  }

  provisioner "file" {
    source      = "${path.root}/../docker/Caddyfile"
    destination = "/tmp/polynovea-files/Caddyfile"
  }

  provisioner "shell" {
    execute_command = "sudo -E sh -eux '{{ .Path }}'"
    environment_vars = [
      "POLYNOVEA_IMAGE_REF=${var.image_ref}",
      "POLYNOVEA_CADDY_IMAGE_REF=${var.caddy_image_ref}",
      "POLYNOVEA_RELEASE_ID=${var.release_id}",
      "POLYNOVEA_CLOUD=aws",
    ]
    script = "${path.root}/provision.sh"
  }

  # The build's temporary SSH key must not stay in the AMI; cloud-init installs the launch key pair.
  provisioner "shell" {
    inline = [
      "sudo rm -f /home/ubuntu/.ssh/authorized_keys /root/.ssh/authorized_keys",
      "sudo cloud-init clean --logs",
    ]
  }
}
