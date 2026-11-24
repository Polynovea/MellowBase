#!/usr/bin/env python3
"""Polynovea upgrade agent: runs an in-app upgrade on the host (polynovea-upgrade.service, as root).

The CMS container has no Docker access and no capabilities. When an admin clicks Upgrade, the CMS
writes one small file, <request dir>/request.json, and systemd's path unit starts this agent. The
agent trusts nothing in that file except the release identifier: it fetches the release itself from
the operator's release channel, verifies it with the installed release key, and only moves forward.

Steps (each recorded in <status dir>/status.json, which the CMS reads and copies into its audit log):

  1. backup     docker exec <cms> polynovea-cms system backup   (pgBackRest, or pg_dump for a managed DB)
  2. verify     cosign verify-blob on release.json; cosign verify on <image>@<digest>
  3. pull       docker pull <image>@<digest>
  4. migrate    one-shot container of the NEW image: polynovea-cms system migrate (old one keeps serving)
  5. start      switch the pinned image ref and restart the CMS (systemd or compose)
  6. health     /api/health must report state "running" and the new release within 120 s
  7. switch     traffic stays on the new release; it becomes the last good one

If step 6 fails: the previous image is started again. When release.json does not say its migrations
are compatible with the previous release ("rollback": "compatible"), the pre-upgrade backup is
restored first (bundled database), or the status says the operator must restore (managed database).

File handling (the CMS, uid 10001, can write the request folder; this process is root):
  * The request is opened with O_NOFOLLOW|O_NONBLOCK relative to the request folder's descriptor, must
    be a regular file owned by the CMS user with one link, at most 4 KB, strict JSON. Only "releaseId"
    is read. The agent never writes, renames or changes anything in the request folder.
  * Status and agent state live in a root-owned 0755 folder outside the CMS's data disk. Files there
    are written through that folder's descriptor: a new temporary file (O_EXCL|O_NOFOLLOW), fsync,
    then rename over the old one.
  * Command output that could carry connection strings never reaches the status file; only fixed
    messages and exit codes do. Journald gets scrubbed last lines.

Configuration: /etc/polynovea/upgrade.env (root-owned; KEY=value lines). See docs/self-hosting/upgrades.md.
"""

from __future__ import annotations

import errno
import fcntl
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import ssl
from datetime import datetime, timezone

MAX_REQUEST_BYTES = 4096
MAX_RELEASE_BYTES = 64 * 1024
MAX_POINTER_BYTES = 4096
MAX_SIG_BYTES = 1024
HEALTH_DEADLINE_S = 120
HEALTH_INTERVAL_S = 3
RESTORE_WAIT_INTERVAL_S = 10
RESTORE_TEST_NAME = re.compile(r"^[0-9a-f-]{36}$")
RESTORE_TEST_FRESH_S = 2 * 3600
MAX_RESTORE_WAIT_S = 900
MAX_FAILED_ATTEMPTS = 3
LSN = re.compile(r"^[0-9A-F]{1,8}/[0-9A-F]{1,8}$")
LOCAL_DB = "/opt/polynovea/bin/local-db.sh"
RELEASE_ID = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+_-]{0,127}$")
SEMVER = re.compile(r"^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,64}))?$")
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
IMAGE = re.compile(r"^[a-z0-9][a-z0-9./:_-]{0,254}$")
PINNED = re.compile(r"^[a-z0-9][a-z0-9./:_-]*@sha256:[0-9a-f]{64}$")
REL_PATH = re.compile(r"^[A-Za-z0-9_+-][A-Za-z0-9._+-]*(/[A-Za-z0-9_+-][A-Za-z0-9._+-]*)*$")
LABEL = re.compile(r"^[0-9A-Za-z_-]{1,64}$")
SECRETISH = re.compile(r"(postgres(?:ql)?://\S+|password=\S+|PGPASSWORD=\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----)", re.I)
# The operator command inside the CMS image (scripts/polynovea-cms.mjs, run from /app).
CLI = ["node", "scripts/polynovea-cms.mjs"]
COSIGN_IMAGE = "ghcr.io/sigstore/cosign/cosign:v2.6.1@sha256:68839b7f13dac5a6744a5d8818e984dd39183374e37855c19e14d623d9bc9037"

DEFAULTS = {
    "RUNTIME": "systemd",  # systemd | compose
    "REQUEST_DIR": "/var/lib/polynovea/upgrade-requests",
    # A restore test works in a folder here; an upgrade waits for it (RESTORE_WAIT_S at most), then goes on.
    "RESTORE_TEST_DIR": "/var/lib/polynovea/restore-test",
    "RESTORE_WAIT_S": "900",
    "STATUS_DIR": "/var/lib/polynovea-upgrade",
    "DATA_DIR": "/var/lib/polynovea",  # the data disk as dockerd sees it (systemd runtime one-shots)
    "WORK_DIR": "/var/lib/polynovea-upgrade/work",  # release files are checked here; dockerd binds it into cosign
    "CMS_UID": "10001",
    "CONTAINER": "polynovea",
    "PUBKEY": "/etc/polynovea/release.pub",
    "CHANNEL_URL": "",
    "ENV_FILE": "/etc/polynovea/polynovea.env",  # systemd: the agent pins POLYNOVEA_IMAGE_REF here
    "IMAGE_FILE": "/etc/polynovea/image.env",  # systemd: provision.sh's pin, used while ENV_FILE has none
    "IMAGE_KEY": "POLYNOVEA_IMAGE_REF",  # compose: POLYNOVEA_IMAGE in the compose folder's .env
    "SERVICE": "polynovea",  # systemd unit, or the compose service
    "COMPOSE_DIR": "",
    "COMPOSE_PROJECT": "polynovea",
    "COMPOSE_PROFILE": "",
    "HEALTH_URL": "http://127.0.0.1:3000/api/health",
    "HEALTH_CA_FILE": "",  # compose proxy profile: Caddy's CA for https://localhost (tests)
    "HEALTH_DEADLINE_S": str(HEALTH_DEADLINE_S),
    "ALLOW_HTTP_CHANNEL": "0",  # tests only: http on loopback for the channel
    "DOCKER": "docker",
    "SYSTEMCTL": "systemctl",
    "COSIGN_IMAGE": COSIGN_IMAGE,
    "COSIGN_NETWORK": "host",
}


class Refused(Exception):
    """The request or the release is not acceptable; nothing was changed."""


class StepFailed(Exception):
    def __init__(self, step: str, message: str):
        super().__init__(message)
        self.step = step


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def log(message: str) -> None:
    print(f"upgrade-agent: {SECRETISH.sub('[redacted]', message)}", flush=True)


def load_config(path: str) -> dict:
    config = dict(DEFAULTS)
    try:
        with open(path, encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                if key in DEFAULTS:
                    config[key] = value.strip().strip("'\"")
    except FileNotFoundError:
        pass
    for key in DEFAULTS:  # tests and the unit may override with POLYNOVEA_UPGRADE_<KEY>
        value = os.environ.get(f"POLYNOVEA_UPGRADE_{key}")
        if value is not None:
            config[key] = value
    if not config["CHANNEL_URL"]:
        config["CHANNEL_URL"] = env_value(config["ENV_FILE"], "POLYNOVEA_RELEASE_CHANNEL_URL") or ""
    return config


def env_value(path: str, key: str) -> str | None:
    try:
        with open(path, encoding="utf-8") as handle:
            value = None
            for line in handle:
                if line.startswith(f"{key}="):
                    value = line[len(key) + 1 :].strip().strip("'\"")
            return value
    except FileNotFoundError:
        return None


# ── Request (CMS-writable folder: read only, never followed, never changed) ──────────────────────


def _no_duplicates(pairs):
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise Refused("request.json repeats a key")
    return dict(pairs)


def _no_constants(name):
    raise Refused("request.json is not strict JSON")


def read_request(request_dir: str, cms_uid: int) -> tuple[str, str]:
    """Returns (releaseId, fingerprint). Raises Refused for anything unexpected."""
    try:
        dir_fd = os.open(request_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as error:
        raise Refused(f"request folder unusable ({errno.errorcode.get(error.errno, error.errno)})") from None
    try:
        try:
            fd = os.open("request.json", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC, dir_fd=dir_fd)
        except FileNotFoundError:
            raise Refused("no request") from None
        except OSError as error:
            raise Refused(f"request not opened ({errno.errorcode.get(error.errno, error.errno)})") from None
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise Refused("request is not a regular file")
            if info.st_uid != cms_uid:
                raise Refused("request is not owned by the CMS user")
            if info.st_nlink != 1:
                raise Refused("request has more than one link")
            if info.st_size > MAX_REQUEST_BYTES:
                raise Refused("request is larger than 4 KB")
            data = os.read(fd, MAX_REQUEST_BYTES + 1)
            if len(data) > MAX_REQUEST_BYTES:
                raise Refused("request is larger than 4 KB")
        finally:
            os.close(fd)
    finally:
        os.close(dir_fd)
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_no_duplicates, parse_constant=_no_constants)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Refused("request.json is not strict JSON") from None
    if not isinstance(value, dict):
        raise Refused("request.json is not an object")
    release_id = value.get("releaseId")
    if not isinstance(release_id, str) or not RELEASE_ID.match(release_id):
        raise Refused("request.json has no valid releaseId")
    fingerprint = hashlib.sha256(f"{info.st_ino}:{info.st_mtime_ns}:".encode() + data).hexdigest()
    return release_id, fingerprint


# ── Status folder (root-owned; written only through its descriptor) ──────────────────────────────


class StatusDir:
    def __init__(self, path: str):
        try:
            os.makedirs(path, mode=0o755, exist_ok=True)
        except FileExistsError:
            pass
        self.fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        info = os.fstat(self.fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise SystemExit(f"upgrade-agent: {path} must be owned by root and not group/other-writable")
        # The CMS must read status.json through its read-only mount; nobody but root can write here.
        os.fchmod(self.fd, 0o755)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions

    def read_json(self, name: str) -> dict | None:
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.fd)
        except FileNotFoundError:
            return None
        with os.fdopen(fd, "rb") as handle:
            try:
                value = json.loads(handle.read(1024 * 1024))
            except json.JSONDecodeError:
                return None
        return value if isinstance(value, dict) else None

    def write_json(self, name: str, value: dict) -> None:
        data = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode()
        for _ in range(5):
            temp = f".{name}.{os.getpid()}.{time.monotonic_ns()}.tmp"
            try:
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=self.fd)
                break
            except FileExistsError:
                continue
        else:
            raise OSError("could not create a temporary status file")
        try:
            os.fchmod(fd, 0o644)
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
        os.fsync(self.fd)

    def lock(self) -> int:
        fd = os.open(".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=self.fd)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise SystemExit("upgrade-agent: another upgrade is running")
        return fd


class Status:
    """The status file the CMS reads: one entry per step, written after every change."""

    def __init__(self, folder: StatusDir, release_id: str, from_release: str | None):
        self.folder = folder
        self.value = {
            "schema": 1,
            "releaseId": release_id,
            "fromRelease": from_release,
            "status": "running",
            "digest": None,
            "rollback": None,
            "startedAt": now(),
            "finishedAt": None,
            "steps": [],
        }
        self.save()

    @classmethod
    def resume(cls, folder: StatusDir, value: dict) -> "Status":
        """The status of an upgrade a previous run of the agent left 'running'."""
        status = cls.__new__(cls)
        status.folder = folder
        status.value = value
        status.value.setdefault("steps", [])
        return status

    def save(self) -> None:
        self.folder.write_json("status.json", self.value)

    def step(self, name: str, outcome: str, detail: str | None = None) -> None:
        entry = {"step": name, "outcome": outcome, "at": now()}
        if detail:
            entry["detail"] = SECRETISH.sub("[redacted]", detail)[:300]
        self.value["steps"].append(entry)
        log(f"{name}: {outcome}{' - ' + entry['detail'] if detail else ''}")
        self.save()

    def finish(self, status: str) -> None:
        self.value["status"] = status
        self.value["finishedAt"] = now()
        self.save()


# ── Commands ────────────────────────────────────────────────────────────────────────────────────


def run(args: list[str], timeout: int, capture: bool = True) -> subprocess.CompletedProcess:
    try:
        result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=capture, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(args, 124, "", "timed out")
    except FileNotFoundError:
        return subprocess.CompletedProcess(args, 127, "", f"{args[0]} not found")
    if result.returncode != 0 and capture:
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
        for line in tail:
            log(f"  {args[0]} {args[1] if len(args) > 1 else ''}: {line}")
    return result


class Runtime:
    """Where the pinned image reference lives and how the CMS is restarted."""

    def __init__(self, config: dict):
        self.config = config
        self.docker = config["DOCKER"]
        self.kind = config["RUNTIME"]
        if self.kind not in ("systemd", "compose"):
            raise SystemExit("upgrade-agent: RUNTIME must be systemd or compose")
        if self.kind == "compose":
            if not config["COMPOSE_DIR"]:
                raise SystemExit("upgrade-agent: COMPOSE_DIR is required for the compose runtime")
            self.ref_file = os.path.join(config["COMPOSE_DIR"], ".env")
            self.ref_key = "POLYNOVEA_IMAGE"
        else:
            self.ref_file = config["ENV_FILE"]
            self.ref_key = config["IMAGE_KEY"]

    def current_ref(self) -> str | None:
        # The same order as run-cms.sh and verify-images.sh: polynovea.env wins over image.env.
        ref = env_value(self.ref_file, self.ref_key)
        if not ref and self.kind == "systemd":
            ref = env_value(self.config["IMAGE_FILE"], self.ref_key)
        return ref if ref and PINNED.match(ref) else None

    def set_ref(self, ref: str) -> None:
        if not PINNED.match(ref):
            raise StepFailed("start", "refusing an image reference that is not pinned by digest")
        folder = os.path.dirname(self.ref_file) or "."
        lines: list[str] = []
        try:
            with open(self.ref_file, encoding="utf-8") as handle:
                lines = [line for line in handle.read().splitlines() if not line.startswith(f"{self.ref_key}=")]
        except FileNotFoundError:
            pass
        lines.append(f"{self.ref_key}={ref}")
        info = os.stat(self.ref_file) if os.path.exists(self.ref_file) else None
        fd, temp = tempfile.mkstemp(dir=folder, prefix=".polynovea-upgrade.")
        try:
            os.write(fd, ("\n".join(lines) + "\n").encode())
            os.fchmod(fd, info.st_mode & 0o777 if info else 0o600)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(temp, self.ref_file)

    def restart(self) -> bool:
        if self.kind == "systemd":
            return run([self.config["SYSTEMCTL"], "restart", self.config["SERVICE"]], 900).returncode == 0
        args = [self.docker, "compose", "--project-directory", self.config["COMPOSE_DIR"], "-p", self.config["COMPOSE_PROJECT"]]
        if self.config["COMPOSE_PROFILE"]:
            args += ["--profile", self.config["COMPOSE_PROFILE"]]
        return run(args + ["up", "-d", "--no-deps", "--force-recreate", self.config["SERVICE"]], 900).returncode == 0

    def stop(self) -> bool:
        if self.kind == "systemd":
            return run([self.config["SYSTEMCTL"], "stop", self.config["SERVICE"]], 300).returncode == 0
        return run([self.docker, "stop", "--time", "90", self.config["CONTAINER"]], 300).returncode in (0, 1)


# ── Release channel ─────────────────────────────────────────────────────────────────────────────


class _HttpsOnlyRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, allow_http: bool):
        self.allow_http = allow_http

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not _channel_url_ok(newurl, self.allow_http):
            raise urllib.error.URLError("redirect to a non-HTTPS URL refused")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _channel_url_ok(url: str, allow_http: bool) -> bool:
    parts = urllib.parse.urlsplit(url)
    if parts.username or parts.password:
        return False
    if parts.scheme == "https":
        return True
    return allow_http and parts.scheme == "http" and parts.hostname in ("127.0.0.1", "localhost")


def fetch(url: str, limit: int, allow_http: bool) -> bytes:
    if not _channel_url_ok(url, allow_http):
        raise Refused("the release channel must use HTTPS")
    opener = urllib.request.build_opener(_HttpsOnlyRedirects(allow_http))
    try:
        with opener.open(urllib.request.Request(url, headers={"User-Agent": "polynovea-upgrade-agent"}), timeout=15) as response:
            data = response.read(limit + 1)
    except (urllib.error.URLError, OSError) as error:
        raise Refused(f"the release channel could not be read ({type(error).__name__})") from None
    if len(data) > limit:
        raise Refused("a release channel file is larger than allowed")
    return data


def child_url(base: str, relative) -> str:
    if not isinstance(relative, str) or not REL_PATH.match(relative) or any(part in (".", "..") for part in relative.split("/")):
        raise Refused("latest.json names an invalid path")
    return urllib.parse.urljoin(base, relative)


def version_key(version: str):
    """Semantic-version order: a pre-release sorts before its release; pre-release identifiers compare
    numerically when numeric (rc.10 > rc.9) and numeric ones before alphanumeric ones."""
    match = SEMVER.match(version)
    if not match:
        raise Refused("invalid version")
    core = (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    pre = match.group(4)
    if not pre:
        return core + (1, ())
    return core + (0, tuple((0, int(part), "") if part.isdigit() else (1, 0, part) for part in pre.split(".")))


def cosign(config: dict, args: list[str], mounts: list[tuple[str, str]]) -> bool:
    command = [config["DOCKER"], "run", "--rm", "--network", config["COSIGN_NETWORK"], "--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"]
    for source, target in mounts:
        command += ["-v", f"{source}:{target}:ro"]
    return run(command + [config["COSIGN_IMAGE"]] + args, 600).returncode == 0


def fetch_and_verify_release(config: dict, release_id: str, status: Status) -> dict:
    base = config["CHANNEL_URL"].rstrip("/") + "/"
    allow_http = config["ALLOW_HTTP_CHANNEL"] == "1"
    if not config["CHANNEL_URL"]:
        raise Refused("no release channel is configured")
    pointer = json.loads(fetch(urllib.parse.urljoin(base, "latest.json"), MAX_POINTER_BYTES, allow_http))
    if not isinstance(pointer, dict) or pointer.get("schema") != 1 or pointer.get("releaseId") != release_id:
        raise Refused("the requested release is not the channel's latest; check for updates again")
    release_bytes = fetch(child_url(base, pointer.get("release")), MAX_RELEASE_BYTES, allow_http)
    signature = fetch(child_url(base, pointer.get("signature")), MAX_SIG_BYTES, allow_http)
    if config["WORK_DIR"]:
        os.makedirs(config["WORK_DIR"], mode=0o755, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="polynovea-release-", dir=config["WORK_DIR"] or None) as work:
        # Read-only bind mount into the cosign container (another uid): signed public files only.
        os.chmod(work, 0o755)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions
        with open(os.path.join(work, "release.json"), "wb") as handle:
            handle.write(release_bytes)
        with open(os.path.join(work, "release.json.sig"), "wb") as handle:
            handle.write(signature)
        ok = cosign(
            config,
            ["verify-blob", "--key", "/release.pub", "--insecure-ignore-tlog=true", "--signature", "/work/release.json.sig", "/work/release.json"],
            [(config["PUBKEY"], "/release.pub"), (work, "/work")],
        )
    if not ok:
        raise StepFailed("verify", "release.json's signature does not verify with the installed release key")
    release = json.loads(release_bytes)
    if not isinstance(release, dict) or release.get("schema") != 1 or release.get("releaseId") != release_id:
        raise StepFailed("verify", "release.json does not match the request")
    version, image, digest = release.get("version"), release.get("image"), release.get("digest")
    if not isinstance(version, str) or release_id.split("+")[0] != version:
        raise StepFailed("verify", "release.json has an invalid version")
    version_key(version)
    if not isinstance(image, str) or not IMAGE.match(image) or "@" in image or not isinstance(digest, str) or not DIGEST.match(digest):
        raise StepFailed("verify", "release.json has an invalid image or digest")
    with open(config["PUBKEY"], "rb") as handle:
        key_sum = hashlib.sha256(handle.read()).hexdigest()
    if release.get("publicKeySha256") not in (None, key_sum):
        raise StepFailed("verify", "release.json was made for a different release key")
    ref = f"{image}@{digest}"
    if not cosign(config, ["verify", "--key", "/release.pub", "--insecure-ignore-tlog=true", ref], [(config["PUBKEY"], "/release.pub")]):
        raise StepFailed("verify", "the image signature does not verify with the installed release key")
    return {
        "releaseId": release_id,
        "version": version,
        "ref": ref,
        "digest": digest,
        "rollback": "compatible" if release.get("rollback") == "compatible" else "restore",
    }


# ── Health ──────────────────────────────────────────────────────────────────────────────────────


def health(config: dict) -> dict | None:
    url = config["HEALTH_URL"]
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.hostname not in ("127.0.0.1", "localhost", "::1"):
        log("HEALTH_URL must be http(s) on this machine's loopback")
        return None
    context = None
    if parts.scheme == "https":
        context = ssl.create_default_context(cafile=config["HEALTH_CA_FILE"] or None)
    try:
        # Scheme and host checked above: http(s) on loopback only.
        with urllib.request.urlopen(url, timeout=5, context=context) as response:  # nosemgrep: python.lang.security.audit.dynamic-urllib-use-detected.dynamic-urllib-use-detected
            value = json.loads(response.read(4096))
            return value if isinstance(value, dict) else None
    except (urllib.error.URLError, OSError, ValueError):
        return None


def wait_for_release(config: dict, release_id: str, deadline_s: float) -> bool:
    deadline = time.monotonic() + deadline_s
    while time.monotonic() < deadline:
        value = health(config)
        if value and value.get("state") == "running" and value.get("release") == release_id:
            return True
        time.sleep(HEALTH_INTERVAL_S)
    return False


def running_release(config: dict) -> str | None:
    value = health(config)
    release = value.get("release") if value else None
    return release if isinstance(release, str) and RELEASE_ID.match(release) else None


# ── The upgrade ─────────────────────────────────────────────────────────────────────────────────


def cms_command(config: dict, image_ref: str | None, args: list[str], timeout: int) -> subprocess.CompletedProcess:
    """polynovea-cms in the running container (image_ref None) or a one-shot container of image_ref."""
    docker = config["DOCKER"]
    if image_ref is None:
        return run([docker, "exec", "-w", "/app", config["CONTAINER"]] + CLI + args, timeout)
    # The CMS's own network: the host's on a VM (run-cms.sh), its container's namespace under compose.
    network = "host" if config["RUNTIME"] == "systemd" else f"container:{config['CONTAINER']}"
    command = [docker, "run", "--rm", "--network", network] + one_shot_args(config)
    return run(command + ["--entrypoint", "node", "-w", "/app", image_ref] + CLI[1:] + args, timeout)


def one_shot_args(config: dict) -> list[str]:
    """Data disk, settings and hardening for a one-shot container of a CMS image."""
    args = ["--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"]
    if config["RUNTIME"] == "systemd":
        # run-cms.sh starts the CMS with --rm, so there is no stopped container to borrow volumes from.
        args += ["-v", f"{config['DATA_DIR']}:/var/lib/polynovea"]
        env_file = config["ENV_FILE"]
    else:
        args += ["--volumes-from", config["CONTAINER"]]
        env_file = os.path.join(config["COMPOSE_DIR"], "polynovea.env")
    if os.path.isfile(env_file):
        args += ["--env-file", env_file]
    return args


def last_json_line(text: str) -> dict:
    for line in reversed((text or "").strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return {}


def restore_tests_running(path: str) -> int:
    """Restore-test folders changed in the last RESTORE_TEST_FRESH_S (CMS-owned: listed through a no-follow
    descriptor, never changed). An older folder is a leftover, not a running test, and never delays an upgrade."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError:
        return 0
    try:
        fresh = 0
        for name in os.listdir(fd):
            if not RESTORE_TEST_NAME.match(name):
                continue
            try:
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except OSError:
                continue
            if stat.S_ISDIR(info.st_mode) and time.time() - info.st_mtime < RESTORE_TEST_FRESH_S:
                fresh += 1
        return fresh
    finally:
        os.close(fd)


def wait_for_restore_test(config: dict, status: "Status") -> None:
    """A restore test takes minutes; an upgrade would cut it off. Wait for it, up to RESTORE_WAIT_S (the most
    a CMS-written folder can ever delay an upgrade)."""
    if not restore_tests_running(config["RESTORE_TEST_DIR"]):
        return
    status.step("wait", "started", "a restore test is running; the upgrade waits for it")
    deadline = time.monotonic() + min(float(config["RESTORE_WAIT_S"]), MAX_RESTORE_WAIT_S)
    while time.monotonic() < deadline:
        if not restore_tests_running(config["RESTORE_TEST_DIR"]):
            status.step("wait", "ok", "the restore test finished")
            return
        time.sleep(RESTORE_WAIT_INTERVAL_S)
    status.step("wait", "skipped", "still running; going on: it is recorded as interrupted and runs again")


# ── Commands in CMS images ──────────────────────────────────────────────────────────────────────


def exec_cli(config: dict, container: str, args: list[str], timeout: int) -> subprocess.CompletedProcess:
    """polynovea-cms inside a running container (the CMS, or the maintenance database container)."""
    return run([config["DOCKER"], "exec", "-w", "/app", container] + CLI + args, timeout)


def one_shot_cli(config: dict, image_ref: str, args: list[str], timeout: int, network: str) -> subprocess.CompletedProcess:
    """polynovea-cms in a one-shot container of image_ref, with the data disk and settings."""
    command = [config["DOCKER"], "run", "--rm", "--network", network] + one_shot_args(config)
    return run(command + ["--entrypoint", "node", "-w", "/app", image_ref] + CLI[1:] + args, timeout)


def one_shot_args(config: dict) -> list[str]:
    """Data disk, settings and hardening for a one-shot container of a CMS image."""
    args = ["--security-opt", "no-new-privileges:true", "--cap-drop", "ALL"]
    if config["RUNTIME"] == "systemd":
        # run-cms.sh starts the CMS with --rm, so there is no stopped container to borrow volumes from.
        args += ["-v", f"{config['DATA_DIR']}:/var/lib/polynovea"]
        env_file = config["ENV_FILE"]
    else:
        args += ["--volumes-from", config["CONTAINER"]]
        env_file = os.path.join(config["COMPOSE_DIR"], "polynovea.env")
    if os.path.isfile(env_file):
        args += ["--env-file", env_file]
    return args


def host_network(config: dict) -> str:
    """The network a one-shot uses when the CMS is not running: the host's on a VM, Docker's default otherwise."""
    return "host" if config["RUNTIME"] == "systemd" else "bridge"


def last_json_line(text: str) -> dict:
    for line in reversed((text or "").strip().splitlines()):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            return value
    return {}


def backup_receipt(result: subprocess.CompletedProcess) -> tuple[str, str | None]:
    if result.returncode != 0:
        raise StepFailed("backup", f"the pre-upgrade backup failed (exit {result.returncode})")
    receipt = last_json_line(result.stdout)
    kind = receipt.get("kind") if receipt.get("kind") in ("pgbackrest", "pg_dump") else None
    label = receipt.get("label") if isinstance(receipt.get("label"), str) and LABEL.match(receipt["label"]) else None
    if kind is None or (kind == "pgbackrest" and label is None):
        raise StepFailed("backup", "the backup did not report what it saved")
    return kind, label


class MaintenanceDatabase:
    """The bundled database without the CMS: a container of the running image that starts only PostgreSQL,
    so nothing can write while the backup is taken and the migrations run."""

    def __init__(self, config: dict, image_ref: str):
        self.config = config
        self.image_ref = image_ref
        self.name = f"{config['CONTAINER']}-upgrade-db"

    def start(self) -> None:
        docker = self.config["DOCKER"]
        run([docker, "rm", "-f", self.name], 60)
        command = [docker, "run", "-d", "--name", self.name, "--network", host_network(self.config)] + one_shot_args(self.config)
        command += ["--entrypoint", "sh", self.image_ref, "-c", f"{LOCAL_DB} start && exec sleep infinity"]
        if run(command, 300).returncode != 0:
            raise StepFailed("maintenance", "the database could not be started without the CMS")
        for _ in range(60):
            if run([docker, "exec", self.name, LOCAL_DB, "status"], 30).returncode == 0:
                return
            time.sleep(1)
        raise StepFailed("maintenance", "the database did not come up without the CMS")

    def stop(self) -> None:
        docker = self.config["DOCKER"]
        run([docker, "exec", self.name, LOCAL_DB, "stop"], 120)
        run([docker, "rm", "-f", self.name], 120)

    def network(self) -> str:
        return "host" if self.config["RUNTIME"] == "systemd" else f"container:{self.name}"


# ── The upgrade ─────────────────────────────────────────────────────────────────────────────────


def release_floor(config: dict, previous_ref: str | None, state: dict) -> str | None:
    """The running release, from root-side sources only (never the CMS's /api/health): the pinned image's
    release label, then the agent's own last good release, then provision.sh's image.env."""
    candidates = []
    if previous_ref:
        result = run([config["DOCKER"], "image", "inspect", "--format", '{{index .Config.Labels "io.polynovea.release-id"}}', previous_ref], 60)
        candidates.append(result.stdout.strip() if result.returncode == 0 else "")
    if state.get("lastGoodRef") == previous_ref:
        candidates.append(str(state.get("lastGoodRelease") or ""))
    candidates.append(env_value(config["IMAGE_FILE"], "POLYNOVEA_RELEASE_ID") or "")
    for candidate in candidates:
        if RELEASE_ID.match(candidate) and SEMVER.match(candidate.split("+")[0]):
            return candidate
    return None


def save_inflight(folder: StatusDir, **values) -> dict:
    state = folder.read_json("state.json") or {}
    inflight = {**(state.get("inFlight") or {}), **values}
    folder.write_json("state.json", {**state, "inFlight": inflight})
    return inflight


def clear_inflight(folder: StatusDir, **extra) -> None:
    state = folder.read_json("state.json") or {}
    state.pop("inFlight", None)
    folder.write_json("state.json", {**state, **extra})


def record_failure(folder: StatusDir, release_id: str) -> None:
    state = folder.read_json("state.json") or {}
    failures = dict(state.get("failures") or {})
    failures[release_id] = int(failures.get(release_id, 0)) + 1
    folder.write_json("state.json", {**state, "failures": failures})


def upgrade(config: dict, folder: StatusDir, runtime: Runtime, status: Status, release_id: str) -> str:
    """Runs one upgrade. Raises Refused/StepFailed before anything changed; any later failure is handled by
    the caller through the in-flight record (recover)."""
    previous_ref = runtime.current_ref()
    state = folder.read_json("state.json") or {}
    deadline = float(config["HEALTH_DEADLINE_S"])
    if previous_ref is None:
        raise Refused("the running image is not pinned by digest; upgrade by hand once")
    floor = release_floor(config, previous_ref, state)
    if floor is None:
        raise Refused("the running release cannot be established from the image, the agent's state or image.env")
    status.value["fromRelease"] = floor
    status.save()
    if version_key(release_id.split("+")[0]) <= version_key(floor.split("+")[0]):
        raise Refused(f"{release_id} is not newer than the running release {floor}")
    failures = int((state.get("failures") or {}).get(release_id, 0))
    if failures >= MAX_FAILED_ATTEMPTS:
        raise Refused(f"{release_id} has failed {failures} times; an operator must reset it (upgrade-agent.py --reset-failures)")

    status.step("verify", "started")
    release = fetch_and_verify_release(config, release_id, status)
    status.value["digest"] = release["digest"]
    status.value["rollback"] = release["rollback"]
    status.step("verify", "ok", f"signature verified; rollback {release['rollback']}")

    status.step("pull", "started")
    if run([config["DOCKER"], "pull", "-q", release["ref"]], 1800).returncode != 0:
        raise StepFailed("pull", "the image could not be pulled by digest")
    status.step("pull", "ok", release["digest"])

    wait_for_restore_test(config, status)
    inflight = save_inflight(folder, release=release_id, previousRef=previous_ref, newRef=release["ref"], fromRelease=floor,
                             rollback=release["rollback"], phase="prepared", backupKind=None, backupLabel=None, lsn=None)

    if release["rollback"] == "compatible":
        # The previous release runs on the new schema: it keeps serving through backup and migrations.
        status.step("backup", "started")
        kind, label = backup_receipt(exec_cli(config, config["CONTAINER"], ["system", "backup", "--reason", "pre-upgrade"], 3600))
        save_inflight(folder, backupKind=kind, backupLabel=label)
        status.step("backup", "ok", f"{kind}{' ' + label if label else ''}")
        status.step("migrate", "started")
        network = "host" if config["RUNTIME"] == "systemd" else f"container:{config['CONTAINER']}"
        migrated = one_shot_cli(config, release["ref"], ["system", "migrate"], 3600, network)
        if migrated.returncode != 0:
            raise StepFailed("migrate", f"migrations failed (exit {migrated.returncode}); the running release is unchanged")
        status.step("migrate", "ok")
    else:
        # The previous release cannot use the new schema, so a failure means a restore. Stop taking writes
        # BEFORE the backup, keep the new release from committing until it is healthy, and record the exact
        # WAL position the restore must return to.
        mode = last_json_line(exec_cli(config, config["CONTAINER"], ["system", "mode"], 120).stdout)
        bundled = mode.get("local") is True
        status.step("maintenance", "started", "the CMS stops taking changes for the upgrade")
        runtime.stop()
        save_inflight(folder, phase="stopped")
        status.step("maintenance", "ok")
        status.step("backup", "started")
        if bundled:
            database = MaintenanceDatabase(config, previous_ref)
            database.start()
            try:
                kind, label = backup_receipt(exec_cli(config, database.name, ["system", "backup", "--reason", "pre-upgrade"], 3600))
                save_inflight(folder, backupKind=kind, backupLabel=label)
                status.step("backup", "ok", f"{kind} {label}")
                checkpoint = last_json_line(exec_cli(config, database.name, ["system", "checkpoint"], 600).stdout)
                lsn = checkpoint.get("lsn") if isinstance(checkpoint.get("lsn"), str) and LSN.match(checkpoint["lsn"]) else None
                if lsn is None:
                    raise StepFailed("checkpoint", "the database's position before the migrations could not be recorded")
                # From here a switch-back restores to the recorded position, which also undoes read-only.
                save_inflight(folder, lsn=lsn, phase="migrated")
                status.step("checkpoint", "ok", f"restore point {lsn}")
                if exec_cli(config, database.name, ["system", "read-only", "on"], 120).returncode != 0:
                    raise StepFailed("checkpoint", "changes could not be paused for the new release's trial")
                status.step("migrate", "started")
                migrated = one_shot_cli(config, release["ref"], ["system", "migrate"], 3600, database.network())
                if migrated.returncode != 0:
                    raise StepFailed("migrate", f"migrations failed (exit {migrated.returncode})")
                status.step("migrate", "ok")
            finally:
                database.stop()
        else:
            kind, label = backup_receipt(one_shot_cli(config, previous_ref, ["system", "backup", "--reason", "pre-upgrade"], 3600, host_network(config)))
            save_inflight(folder, backupKind=kind, backupLabel=label)
            status.step("backup", "ok", kind)
            status.step("migrate", "started")
            save_inflight(folder, phase="migrated")
            migrated = one_shot_cli(config, release["ref"], ["system", "migrate"], 3600, host_network(config))
            if migrated.returncode != 0:
                raise StepFailed("migrate", f"migrations failed (exit {migrated.returncode})")
            status.step("migrate", "ok")

    status.step("start", "started")
    started_at = time.monotonic()
    save_inflight(folder, phase="started")
    runtime.set_ref(release["ref"])
    restarted = runtime.restart()
    status.step("start", "ok" if restarted else "failed")
    healthy = restarted and wait_for_release(config, release_id, max(0.0, deadline - (time.monotonic() - started_at)))
    if healthy and (folder.read_json("state.json") or {}).get("inFlight", {}).get("lsn"):
        # Changes were paused for the trial (restore mode, bundled database): resume them now.
        healthy = exec_cli(config, config["CONTAINER"], ["system", "read-only", "off"], 120).returncode == 0
        if not healthy:
            status.step("switch", "failed", "changes could not be resumed on the new release")
    if not healthy:
        status.step("health", "failed", f"{release_id} not healthy within {int(deadline)} s")
        raise StepFailed("health", "health check failed")
    status.step("health", "ok", f"{release_id} healthy after {int(time.monotonic() - started_at)} s")
    status.step("switch", "ok", "traffic on the new release")
    clear_inflight(folder, lastGoodRef=release["ref"], lastGoodRelease=release_id, at=now())
    status.finish("succeeded")
    return "succeeded"


def recover(config: dict, folder: StatusDir, runtime: Runtime, status: Status, inflight: dict, start_now: bool = True) -> str:
    """Puts the previous release back after a failure at any point after 'prepared'. With start_now False
    (at boot, before polynovea.service) it only fixes the pin and the database; the service starts it."""
    phase = inflight.get("phase")
    previous_ref = inflight.get("previousRef")
    if phase in (None, "prepared") or not previous_ref:
        # Nothing was changed: the previous release is still running.
        status.finish("failed")
        clear_inflight(folder)
        return "failed"
    status.step("rollback", "started", f"to {inflight.get('fromRelease') or previous_ref}")
    started_at = time.monotonic()
    runtime.set_ref(previous_ref)
    final = "rolled_back"
    if inflight.get("rollback") != "compatible":
        runtime.stop()
        if inflight.get("backupKind") == "pgbackrest" and inflight.get("backupLabel") and phase in ("migrated", "started"):
            status.step("restore", "started", f"{inflight['backupLabel']}{' to ' + inflight['lsn'] if inflight.get('lsn') else ''}")
            restored = run_restore(config, previous_ref, inflight["backupLabel"], inflight.get("lsn"))
            status.step("restore", "ok" if restored else "failed")
            if not restored:
                final = "restore_needed"
        elif inflight.get("backupKind") == "pg_dump" and phase in ("migrated", "started"):
            status.step("restore", "skipped", "managed database: restore the pre-upgrade dump or the cloud backup by hand")
            final = "restore_needed"
    if not start_now:
        status.step("rollback", "ok", "the previous release starts with the server")
        status.finish(final)
        clear_inflight(folder)
        return final
    runtime.restart()
    from_release = inflight.get("fromRelease")
    back = wait_for_release(config, from_release, float(config["HEALTH_DEADLINE_S"])) if from_release else health(config) is not None
    status.step("rollback", "ok" if back else "failed", f"after {int(time.monotonic() - started_at)} s")
    result = final if back else "failed"
    status.finish(result)
    clear_inflight(folder)
    return result


def run_restore(config: dict, image_ref: str, label: str, lsn: str | None) -> bool:
    """Restores the pre-upgrade pgBackRest backup into the stopped bundled database, to the recorded WAL
    position when there is one (every change committed before the migrations started)."""
    args = ["system", "restore-backup", "--set", label] + (["--lsn", lsn] if lsn else [])
    return one_shot_cli(config, image_ref, args, 3600, host_network(config)).returncode == 0


def run_upgrade(config: dict, folder: StatusDir, runtime: Runtime, release_id: str) -> str:
    """One upgrade, with every failure ending in a final status: refused/failed before any change, a
    switch-back after one, including unexpected errors."""
    status = Status(folder, release_id, None)
    try:
        return upgrade(config, folder, runtime, status, release_id)
    except Refused as error:
        status.step("request", "failed", str(error))
        status.finish("failed")
        clear_inflight(folder)
        return "failed"
    except StepFailed as error:
        if error.step != "health":
            status.step(error.step, "failed", str(error))
        result = recover(config, folder, runtime, status, (folder.read_json("state.json") or {}).get("inFlight") or {})
    except Exception as error:  # noqa: BLE001 - every failure must end in a final status and a switch-back
        status.step("agent", "failed", f"unexpected error ({type(error).__name__}); switching back")
        log(f"unexpected error: {SECRETISH.sub('[redacted]', repr(error))}")
        try:
            result = recover(config, folder, runtime, status, (folder.read_json("state.json") or {}).get("inFlight") or {})
        except Exception as nested:  # noqa: BLE001
            log(f"switch-back failed: {type(nested).__name__}")
            status.finish("failed")
            result = "failed"
    record_failure(folder, release_id)
    return result


def resume_interrupted(config: dict, folder: StatusDir, start_now: bool) -> str | None:
    """At start (under the lock): an upgrade left 'running' by a reboot, a timeout or a kill is finished
    now, switching back when the new release never passed its health check."""
    previous = folder.read_json("status.json")
    if not previous or previous.get("status") != "running":
        return None
    state = folder.read_json("state.json") or {}
    inflight = state.get("inFlight") or {}
    status = Status.resume(folder, previous)
    status.step("resume", "started", "the agent stopped during this upgrade (reboot, timeout or crash)")
    runtime = Runtime(config)
    try:
        result = recover(config, folder, runtime, status, inflight, start_now=start_now)
    except Exception as error:  # noqa: BLE001
        log(f"resume failed: {type(error).__name__}")
        status.finish("failed")
        result = "failed"
    if inflight.get("release"):
        record_failure(folder, inflight["release"])
    return result


def main(argv: list[str]) -> int:
    config = load_config(os.environ.get("POLYNOVEA_UPGRADE_CONFIG", "/etc/polynovea/upgrade.env"))
    folder = StatusDir(config["STATUS_DIR"])
    if argv == ["--mark"]:
        # Tells the CMS an agent is installed (it offers upgrades only then). Run by provision.sh, or
        # once by hand on a compose host.
        Runtime(config)  # validates RUNTIME and COMPOSE_DIR
        folder.write_json("agent.json", {"schema": 1, "runtime": config["RUNTIME"], "at": now()})
        return 0
    lock = folder.lock()
    try:
        if argv == ["--reset-failures"]:
            state = folder.read_json("state.json") or {}
            state.pop("failures", None)
            folder.write_json("state.json", state)
            log("failed-upgrade counts reset")
            return 0
        if argv == ["--recover"]:
            # polynovea-upgrade-recover.service, at boot before polynovea.service: fix the pin, don't start.
            result = resume_interrupted(config, folder, start_now=False)
            log(f"recover: {result or 'nothing to recover'}")
            return 0
        resumed = resume_interrupted(config, folder, start_now=True)
        if resumed:
            log(f"an interrupted upgrade was finished: {resumed}")
        try:
            release_id, fingerprint = read_request(config["REQUEST_DIR"], int(config["CMS_UID"]))
        except Refused as error:
            if str(error) != "no request":
                log(f"request ignored: {error}")
                folder.write_json("last-refusal.json", {"at": now(), "reason": str(error)})
            return 0 if str(error) == "no request" else 2
        state = folder.read_json("state.json") or {}
        if state.get("lastRequest") == fingerprint:
            log("request already handled")
            return 0
        folder.write_json("state.json", {**state, "lastRequest": fingerprint})
        result = run_upgrade(config, folder, Runtime(config), release_id)
        log(f"finished: {result}")
        return 0 if result == "succeeded" else 1
    finally:
        os.close(lock)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
