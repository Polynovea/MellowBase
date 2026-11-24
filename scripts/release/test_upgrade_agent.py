"""Tests for release/packer/files/upgrade-agent.py. Linux only (O_NOFOLLOW, fifos, fchmod).

    python3 -I -B scripts/release/test_upgrade_agent.py   (any user; no Docker, no systemd)

Docker, cosign, systemctl and the CMS are fakes: a shell script records every call, and a local HTTP
server plays both the release channel and /api/health.
"""

import http.server
import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
AGENT_PATH = os.path.join(HERE, "..", "..", "release", "packer", "files", "upgrade-agent.py")
spec = importlib.util.spec_from_file_location("upgrade_agent", AGENT_PATH)
agent = importlib.util.module_from_spec(spec)
spec.loader.exec_module(agent)
agent.HEALTH_INTERVAL_S = 0.2
agent.RESTORE_WAIT_INTERVAL_S = 0.2

DIGEST_A = "sha256:" + "a" * 64
DIGEST_B = "sha256:" + "b" * 64
IMAGE = "registry.example/polynovea-cms"
REF_A = f"{IMAGE}@{DIGEST_A}"
REF_B = f"{IMAGE}@{DIGEST_B}"
RELEASE_A = "0.4.0+aaaaaaa"
RELEASE_B = "0.4.1+bbbbbbb"

FAKE_DOCKER = r"""#!/bin/sh
# Fake docker/systemctl: records the call, then behaves as the test's control file says.
echo "$(basename "$0") $*" >> "$FAKE_ROOT/calls.log"
control() { sed -n "s/^$1=//p" "$FAKE_ROOT/control" | tail -1; }
case "$*" in
  "image inspect"*)
    label="$(control label)"; [ -z "$label" ] && label="0.4.0+aaaaaaa"
    [ "$label" = none ] && exit 1
    echo "$label"; exit 0 ;;
  *"system mode"*) [ "$(control mode)" = managed ] && echo '{"local":false}' || echo '{"local":true}'; exit 0 ;;
  *"system checkpoint"*) echo '{"lsn":"0/3000060"}'; exit 0 ;;
  *"system read-only"*) exit 0 ;;
  "run -d --name "*|"rm -f "*|*"local-db.sh status"*|*"local-db.sh stop"*) exit 0 ;;
  *verify-blob*) [ "$(control blob)" = ok ] && exit 0 || exit 1 ;;
  *" verify "*) [ "$(control image)" = ok ] && exit 0 || exit 1 ;;
  *"system backup"*)
    [ "$(control backup)" = fail ] && exit 1
    [ "$(control backup)" = pg_dump ] && { echo '{"kind":"pg_dump","file":"x.dump","password":"s3cret"}'; exit 0; }
    echo 'progress postgresql://owner:s3cret@db/x'; echo '{"kind":"pgbackrest","label":"20261124-010101F_20261124-020202I"}'; exit 0 ;;
  *"system migrate"*) [ "$(control migrate)" = fail ] && { echo "error at postgresql://owner:s3cret@db/x" >&2; exit 1; }; exit 0 ;;
  *"system restore-backup"*) exit 0 ;;
  "pull "*|"stop "*) exit 0 ;;
  restart*|"compose "*)
    # The CMS restarts with whatever image the ref file now pins.
    ref="$(sed -n "s/^POLYNOVEA_IMAGE_REF=//p" "$FAKE_ROOT/etc/polynovea.env" | tail -1)"
    [ -f "$FAKE_ROOT/compose/.env" ] && ref="$(sed -n "s/^POLYNOVEA_IMAGE=//p" "$FAKE_ROOT/compose/.env" | tail -1)"
    case "$ref" in
      *bbbbbbbb*) [ "$(control b)" = broken ] && echo '{"state":"unavailable","release":null}' > "$FAKE_ROOT/health.json" \
                  || echo '{"state":"running","release":"0.4.1+bbbbbbb"}' > "$FAKE_ROOT/health.json" ;;
      *) echo '{"state":"running","release":"0.4.0+aaaaaaa"}' > "$FAKE_ROOT/health.json" ;;
    esac
    exit 0 ;;
esac
exit 0
"""


def read(path):
    with open(path) as handle:
        return handle.read()


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True


def make_handler(root):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            path = os.path.join(root, "health.json") if self.path == "/api/health" else os.path.join(root, "channel", self.path.lstrip("/"))
            if not os.path.isfile(path):
                self.send_response(404)
                self.end_headers()
                return
            with open(path, "rb") as handle:
                body = handle.read()
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    return Handler


class AgentTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="upgrade-agent-test-")
        os.chmod(self.root, 0o755)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions (test fixture)
        self.requests = os.path.join(self.root, "requests")
        self.status = os.path.join(self.root, "status")
        os.makedirs(self.requests)
        os.makedirs(os.path.join(self.root, "etc"))
        os.makedirs(os.path.join(self.root, "channel", "0.4.1"))
        os.makedirs(os.path.join(self.root, "bin"))
        for name in ("docker", "systemctl"):
            path = os.path.join(self.root, "bin", name)
            with open(path, "w") as handle:
                handle.write(FAKE_DOCKER)
            os.chmod(path, 0o755)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions (test fixture)
        self.write("etc/polynovea.env", f"POLYNOVEA_DOMAIN=\nPOLYNOVEA_IMAGE_REF={REF_A}\n")
        self.write("etc/release.pub", "-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n")
        self.write("health.json", json.dumps({"state": "running", "release": RELEASE_A}))
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="ok")
        self.publish(rollback="compatible")
        self.server = Server(("127.0.0.1", 0), make_handler(self.root))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        port = self.server.server_address[1]
        self.env = {
            "POLYNOVEA_UPGRADE_CONFIG": os.path.join(self.root, "none.env"),
            "POLYNOVEA_UPGRADE_REQUEST_DIR": self.requests,
            "POLYNOVEA_UPGRADE_STATUS_DIR": self.status,
            "POLYNOVEA_UPGRADE_CMS_UID": str(os.getuid()),
            "POLYNOVEA_UPGRADE_ENV_FILE": os.path.join(self.root, "etc", "polynovea.env"),
            "POLYNOVEA_UPGRADE_IMAGE_FILE": os.path.join(self.root, "etc", "image.env"),
            "POLYNOVEA_UPGRADE_PUBKEY": os.path.join(self.root, "etc", "release.pub"),
            "POLYNOVEA_UPGRADE_CHANNEL_URL": f"http://127.0.0.1:{port}/",
            "POLYNOVEA_UPGRADE_ALLOW_HTTP_CHANNEL": "1",
            "POLYNOVEA_UPGRADE_HEALTH_URL": f"http://127.0.0.1:{port}/api/health",
            "POLYNOVEA_UPGRADE_HEALTH_DEADLINE_S": "3",
            "POLYNOVEA_UPGRADE_RESTORE_TEST_DIR": os.path.join(self.root, "restore-test"),
            "POLYNOVEA_UPGRADE_RESTORE_WAIT_S": "2",
            "POLYNOVEA_UPGRADE_WORK_DIR": os.path.join(self.root, "work"),
            "POLYNOVEA_UPGRADE_DOCKER": os.path.join(self.root, "bin", "docker"),
            "POLYNOVEA_UPGRADE_SYSTEMCTL": os.path.join(self.root, "bin", "systemctl"),
            "FAKE_ROOT": self.root,
        }
        self.saved = {key: os.environ.get(key) for key in self.env}
        os.environ.update(self.env)

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        shutil.rmtree(self.root, ignore_errors=True)
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # helpers
    def write(self, relative, text):
        with open(os.path.join(self.root, relative), "w") as handle:
            handle.write(text)

    def control(self, **values):
        self.write("control", "".join(f"{key}={value}\n" for key, value in values.items()))

    def publish(self, rollback=None, release_id=RELEASE_B, version="0.4.1"):
        release = {"schema": 1, "releaseId": release_id, "version": version, "image": IMAGE, "digest": DIGEST_B}
        if rollback:
            release["rollback"] = rollback
        self.write("channel/latest.json", json.dumps({"schema": 1, "releaseId": release_id, "release": "0.4.1/release.json", "signature": "0.4.1/release.json.sig"}))
        self.write("channel/0.4.1/release.json", json.dumps(release))
        self.write("channel/0.4.1/release.json.sig", "MEUCIQ==\n")

    def request(self, body='{"releaseId": "0.4.1+bbbbbbb"}'):
        path = os.path.join(self.requests, "request.json")
        with open(path, "w") as handle:
            handle.write(body)
        return path

    def run_agent(self):
        return agent.main([])

    def status_json(self):
        with open(os.path.join(self.status, "status.json")) as handle:
            return json.load(handle)

    def calls(self):
        path = os.path.join(self.root, "calls.log")
        return read(path) if os.path.exists(path) else ""

    def ref(self):
        return agent.env_value(os.path.join(self.root, "etc", "polynovea.env"), "POLYNOVEA_IMAGE_REF")

    def snapshot(self, folder):
        result = {}
        for dirpath, dirnames, filenames in os.walk(folder):
            for name in dirnames + filenames:
                path = os.path.join(dirpath, name)
                info = os.lstat(path)
                result[path] = (info.st_mode, info.st_uid, info.st_size, info.st_mtime_ns, info.st_ino)
        return result

    # ── A: the request file ──────────────────────────────────────────────────────────────────
    def test_reads_only_the_release_id_and_ignores_other_fields(self):
        self.request('{"releaseId":"0.4.1+bbbbbbb","image":"evil@sha256:' + "c" * 64 + '","command":"rm -rf /"}')
        release_id, _ = agent.read_request(self.requests, os.getuid())
        self.assertEqual(release_id, RELEASE_B)

    def test_refuses_symlink_fifo_huge_wrong_owner_hardlink_and_loose_json(self):
        target = os.path.join(self.root, "secret.txt")
        self.write("secret.txt", '{"releaseId":"0.4.1+bbbbbbb"}')
        path = os.path.join(self.requests, "request.json")
        os.symlink(target, path)
        with self.assertRaisesRegex(agent.Refused, "not opened"):
            agent.read_request(self.requests, os.getuid())
        os.unlink(path)
        os.mkfifo(path)
        with self.assertRaisesRegex(agent.Refused, "not a regular file"):
            agent.read_request(self.requests, os.getuid())  # O_NONBLOCK: no hang waiting for a writer
        os.unlink(path)
        self.request('{"releaseId":"0.4.1+bbbbbbb","pad":"' + "x" * 5000 + '"}')
        with self.assertRaisesRegex(agent.Refused, "larger than 4 KB"):
            agent.read_request(self.requests, os.getuid())
        self.request()
        with self.assertRaisesRegex(agent.Refused, "not owned by the CMS user"):
            agent.read_request(self.requests, os.getuid() + 1)
        os.link(path, os.path.join(self.root, "hardlink"))
        with self.assertRaisesRegex(agent.Refused, "more than one link"):
            agent.read_request(self.requests, os.getuid())
        os.unlink(os.path.join(self.root, "hardlink"))
        for body, message in (
            ('{"releaseId":"0.4.1+bbbbbbb","releaseId":"9.9.9+x"}', "repeats a key"),
            ('{"releaseId":"0.4.1+bbbbbbb","n":NaN}', "strict JSON"),
            ('["0.4.1+bbbbbbb"]', "not an object"),
            ('{"releaseId":"../../etc/passwd"}', "no valid releaseId"),
            ("\xff\xfe", "strict JSON"),
        ):
            self.request(body)
            with self.assertRaisesRegex(agent.Refused, message):
                agent.read_request(self.requests, os.getuid())

    def test_request_folder_symlink_is_refused(self):
        os.rename(self.requests, self.requests + ".real")
        os.symlink(self.requests + ".real", self.requests)
        self.request()
        with self.assertRaisesRegex(agent.Refused, "request folder unusable"):
            agent.read_request(self.requests, os.getuid())

    def test_a_refused_request_touches_nothing_outside_the_status_folder(self):
        target = os.path.join(self.root, "secret.txt")
        self.write("secret.txt", "untouched")
        os.symlink(target, os.path.join(self.requests, "request.json"))
        before = self.snapshot(self.requests)
        secret_before = os.lstat(target)
        self.assertEqual(self.run_agent(), 2)
        self.assertEqual(self.snapshot(self.requests), before)
        self.assertEqual(open(target).read(), "untouched")
        self.assertEqual(os.lstat(target).st_mtime_ns, secret_before.st_mtime_ns)
        self.assertEqual(self.calls(), "")

    def test_a_full_upgrade_never_writes_in_the_request_folder(self):
        self.request()
        before = self.snapshot(self.requests)
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.snapshot(self.requests), before)

    def test_status_writes_replace_a_planted_symlink_instead_of_following_it(self):
        folder = agent.StatusDir(self.status)
        target = os.path.join(self.root, "victim.txt")
        self.write("victim.txt", "victim")
        os.symlink(target, os.path.join(self.status, "status.json"))
        folder.write_json("status.json", {"ok": True})
        self.assertEqual(open(target).read(), "victim")
        self.assertTrue(stat.S_ISREG(os.lstat(os.path.join(self.status, "status.json")).st_mode))
        self.assertEqual(stat.S_IMODE(os.lstat(os.path.join(self.status, "status.json")).st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(os.stat(self.status).st_mode), 0o755)

    def test_a_writable_status_folder_is_refused(self):
        os.makedirs(self.status)
        os.chmod(self.status, 0o777)  # nosemgrep: python.lang.security.audit.insecure-file-permissions.insecure-file-permissions (test fixture)
        with self.assertRaises(SystemExit):
            agent.StatusDir(self.status)

    def test_the_same_request_is_handled_once(self):
        self.request()
        self.assertEqual(self.run_agent(), 0)
        calls = self.calls()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.calls(), calls)

    # ── The upgrade ──────────────────────────────────────────────────────────────────────────
    def test_upgrade_a_to_b(self):
        self.request()
        self.assertEqual(self.run_agent(), 0)
        status = self.status_json()
        self.assertEqual(status["status"], "succeeded")
        self.assertEqual(status["fromRelease"], RELEASE_A)
        self.assertEqual(status["digest"], DIGEST_B)
        steps = [(s["step"], s["outcome"]) for s in status["steps"]]
        self.assertEqual(steps, [("verify", "started"), ("verify", "ok"), ("pull", "started"), ("pull", "ok"), ("backup", "started"), ("backup", "ok"),
                                 ("migrate", "started"), ("migrate", "ok"), ("start", "started"), ("start", "ok"), ("health", "ok"), ("switch", "ok")])
        self.assertEqual(self.ref(), REF_B)
        calls = self.calls()
        self.assertIn(f"pull -q {REF_B}", calls)
        self.assertIn(f"--entrypoint node -w /app {REF_B} scripts/polynovea-cms.mjs system migrate", calls)
        self.assertLess(calls.index("system backup"), calls.index("system migrate"))
        self.assertLess(calls.index("system migrate"), calls.index("restart polynovea"))
        state = json.loads(read(os.path.join(self.status, "state.json")))
        self.assertEqual(state["lastGoodRef"], REF_B)

    def test_failed_health_switches_back_without_restore_when_compatible(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="broken")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        status = self.status_json()
        self.assertEqual(status["status"], "rolled_back")
        self.assertEqual(self.ref(), REF_A)
        steps = [(s["step"], s["outcome"]) for s in status["steps"]]
        self.assertIn(("health", "failed"), steps)
        self.assertEqual(steps[-1], ("rollback", "ok"))
        self.assertNotIn("restore-backup", self.calls())
        self.assertEqual(json.loads(read(os.path.join(self.root, "health.json")))["release"], RELEASE_A)

    def test_failed_health_restores_the_backup_when_not_declared_compatible(self):
        self.publish(rollback=None)
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="broken")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        status = self.status_json()
        self.assertEqual(status["rollback"], "restore")
        self.assertEqual(status["status"], "rolled_back")
        calls = self.calls()
        # Restored to the WAL position recorded right before the migrations, not only to the backup's end.
        self.assertIn(f"--entrypoint node -w /app {REF_A} scripts/polynovea-cms.mjs system restore-backup --set 20261124-010101F_20261124-020202I --lsn 0/3000060", calls)
        self.assertEqual(self.ref(), REF_A)

    def test_restore_mode_stops_taking_changes_before_the_backup(self):
        # (1) The previous release must not commit anything after the pre-upgrade backup: pull first (no
        # downtime), stop the CMS, back up from a database-only container, record the WAL position, make
        # the app login read-only for the new release's trial, then migrate.
        self.publish(rollback=None)
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="ok")
        self.request()
        self.assertEqual(self.run_agent(), 0)
        calls = self.calls().splitlines()
        def at(text):
            return next(i for i, line in enumerate(calls) if text in line)
        self.assertLess(at(f"pull -q {REF_B}"), at("systemctl stop polynovea"))
        self.assertLess(at("systemctl stop polynovea"), at("run -d --name polynovea-upgrade-db"))
        self.assertLess(at("run -d --name polynovea-upgrade-db"), at("system backup"))
        self.assertIn("exec -w /app polynovea-upgrade-db", calls[at("system backup")])
        self.assertLess(at("system backup"), at("system checkpoint"))
        self.assertLess(at("system checkpoint"), at("system read-only on"))
        self.assertLess(at("system read-only on"), at("system migrate"))
        self.assertLess(at("system migrate"), at("local-db.sh stop"))
        self.assertLess(at("local-db.sh stop"), at("systemctl restart polynovea"))
        # Changes resume only after the new release passed its health check.
        self.assertLess(at("systemctl restart polynovea"), at("system read-only off"))
        self.assertEqual(self.status_json()["status"], "succeeded")

    def test_managed_database_without_compatible_migrations_needs_a_manual_restore(self):
        self.publish(rollback="restore")
        self.control(blob="ok", image="ok", backup="pg_dump", migrate="ok", b="broken")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        status = self.status_json()
        self.assertEqual(status["status"], "restore_needed")
        self.assertIn(("restore", "skipped"), [(s["step"], s["outcome"]) for s in status["steps"]])
        self.assertEqual(self.ref(), REF_A)

    def test_signature_failure_stops_before_any_change(self):
        self.control(blob="bad", image="ok", backup="pgbackrest", migrate="ok", b="ok")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.status_json()["status"], "failed")
        self.assertNotIn("system backup", self.calls())
        self.assertEqual(self.ref(), REF_A)
        self.control(blob="ok", image="bad", backup="pgbackrest", migrate="ok", b="ok")
        self.request('{"releaseId":"0.4.1+bbbbbbb", "again": 1}')
        self.assertEqual(self.run_agent(), 1)
        self.assertNotIn("pull", self.calls())

    def test_failed_migration_leaves_the_running_release_alone(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="fail", b="ok")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        self.assertEqual(self.status_json()["status"], "failed")
        self.assertEqual(self.ref(), REF_A)
        self.assertNotIn("restart", self.calls())

    def test_refuses_downgrades_and_releases_that_are_not_latest(self):
        self.publish(rollback="compatible", release_id="0.3.9+ccccccc", version="0.3.9")
        self.request('{"releaseId":"0.3.9+ccccccc"}')
        self.assertEqual(self.run_agent(), 1)
        self.assertIn("not newer", json.dumps(self.status_json()))
        self.publish(rollback="compatible")
        self.request('{"releaseId":"0.4.2+ddddddd"}')
        self.assertEqual(self.run_agent(), 1)
        self.assertIn("not the channel's latest", json.dumps(self.status_json()))
        self.assertNotIn("system backup", self.calls())

    def test_status_and_logs_hold_no_secrets(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="fail", b="ok")
        self.request()
        self.run_agent()
        for name in os.listdir(self.status):
            text = open(os.path.join(self.status, name)).read() if not name.startswith(".") else ""
            self.assertNotIn("s3cret", text)
            self.assertNotIn("postgresql://", text)

    def test_health_url_is_loopback_http_only(self):
        self.assertIsNone(agent.health({**agent.DEFAULTS, "HEALTH_URL": "file:///etc/shadow"}))
        self.assertIsNone(agent.health({**agent.DEFAULTS, "HEALTH_URL": "http://169.254.169.254/latest"}))

    def test_image_env_pin_is_used_until_polynovea_env_has_one(self):
        self.write("etc/polynovea.env", "POLYNOVEA_DOMAIN=\n")
        self.write("etc/image.env", f"POLYNOVEA_IMAGE_REF={REF_A}\n")
        self.request()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.ref(), REF_B)  # the new pin goes to polynovea.env, which wins
        self.assertIn(f"POLYNOVEA_IMAGE_REF={REF_A}", read(os.path.join(self.root, "etc", "image.env")))

    def test_mark_writes_the_agent_marker(self):
        self.assertEqual(agent.main(["--mark"]), 0)
        marker = json.loads(read(os.path.join(self.status, "agent.json")))
        self.assertEqual(marker["runtime"], "systemd")

    def test_upgrade_waits_for_a_running_restore_test(self):
        folder = os.path.join(self.root, "restore-test", "0f0e0d0c-0b0a-4909-8807-060504030201")
        os.makedirs(folder)
        threading.Timer(0.6, lambda: shutil.rmtree(folder)).start()
        self.request()
        self.assertEqual(self.run_agent(), 0)
        steps = [(s["step"], s["outcome"]) for s in self.status_json()["steps"]]
        self.assertLess(steps.index(("wait", "ok")), steps.index(("backup", "started")))

    def test_upgrade_goes_on_after_the_wait_limit(self):
        os.makedirs(os.path.join(self.root, "restore-test", "0f0e0d0c-0b0a-4909-8807-060504030201"))
        self.request()
        self.assertEqual(self.run_agent(), 0)
        self.assertIn(("wait", "skipped"), [(s["step"], s["outcome"]) for s in self.status_json()["steps"]])

    # ── (3) the downgrade floor comes from root-side sources only ───────────────────────────────
    def test_a_forged_health_response_cannot_lower_the_floor(self):
        self.write("health.json", json.dumps({"state": "running", "release": "0.0.1+forged"}))
        self.publish(rollback="compatible", release_id="0.3.9+ccccccc", version="0.3.9")
        self.request('{"releaseId":"0.3.9+ccccccc"}')
        self.assertEqual(self.run_agent(), 1)
        self.assertIn("not newer than the running release 0.4.0+aaaaaaa", json.dumps(self.status_json()))
        self.assertNotIn("pull", self.calls())

    def test_an_unknown_running_release_is_refused(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="ok", label="none")
        self.request()
        self.assertEqual(self.run_agent(), 1)
        self.assertIn("cannot be established", json.dumps(self.status_json()))
        self.assertNotIn("pull", self.calls())

    def test_the_floor_falls_back_to_image_env(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="ok", label="none")
        self.write("etc/image.env", "POLYNOVEA_RELEASE_ID=0.4.0+aaaaaaa\n")
        self.request()
        self.assertEqual(self.run_agent(), 0)
        self.assertEqual(self.status_json()["fromRelease"], RELEASE_A)

    # ── (7) semantic-version pre-release order ───────────────────────────────────────────────────
    def test_pre_releases_compare_by_semver_rules(self):
        key = agent.version_key
        self.assertGreater(key("1.0.0-rc.10"), key("1.0.0-rc.9"))
        self.assertGreater(key("1.0.0"), key("1.0.0-rc.10"))
        self.assertGreater(key("1.0.0-rc.1"), key("1.0.0-beta.11"))
        self.assertGreater(key("1.0.0-alpha.beta"), key("1.0.0-alpha.1"))
        self.assertGreater(key("1.0.0-alpha.1"), key("1.0.0-alpha"))

    # ── (8) repeat failures need an operator ─────────────────────────────────────────────────────
    def test_a_release_that_failed_three_times_needs_a_reset(self):
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="fail", b="ok")
        for attempt in range(3):
            self.request(json.dumps({"releaseId": RELEASE_B, "n": attempt}))
            self.assertEqual(self.run_agent(), 1)
        self.request(json.dumps({"releaseId": RELEASE_B, "n": 9}))
        self.assertEqual(self.run_agent(), 1)
        self.assertIn("failed 3 times", json.dumps(self.status_json()))
        self.assertEqual(agent.main(["--reset-failures"]), 0)
        self.control(blob="ok", image="ok", backup="pgbackrest", migrate="ok", b="ok")
        self.request(json.dumps({"releaseId": RELEASE_B, "n": 10}))
        self.assertEqual(self.run_agent(), 0)

    def test_an_old_restore_test_folder_does_not_delay_an_upgrade(self):
        folder = os.path.join(self.root, "restore-test", "0f0e0d0c-0b0a-4909-8807-060504030201")
        os.makedirs(folder)
        old = time.time() - 3 * 3600
        os.utime(folder, (old, old))
        self.request()
        self.assertEqual(self.run_agent(), 0)
        self.assertNotIn("wait", [s["step"] for s in self.status_json()["steps"]])

    # ── (2) every failure ends in a final status ─────────────────────────────────────────────────
    def test_an_unexpected_error_after_the_switch_still_switches_back(self):
        real = agent.wait_for_release
        calls = {"n": 0}

        def flaky(config, release_id, deadline):
            calls["n"] += 1
            if calls["n"] == 1:
                raise RuntimeError("boom")
            return real(config, release_id, deadline)

        agent.wait_for_release = flaky
        try:
            self.request()
            self.assertEqual(self.run_agent(), 1)
        finally:
            agent.wait_for_release = real
        status = self.status_json()
        self.assertEqual(status["status"], "rolled_back")
        self.assertIn(("agent", "failed"), [(s["step"], s["outcome"]) for s in status["steps"]])
        self.assertEqual(self.ref(), REF_A)
        self.assertNotIn("inFlight", json.loads(read(os.path.join(self.status, "state.json"))))

    def test_an_unexpected_error_before_any_change_fails_cleanly(self):
        real = agent.fetch_and_verify_release

        def broken(*args):
            raise KeyError("x")

        agent.fetch_and_verify_release = broken
        try:
            self.request()
            self.assertEqual(self.run_agent(), 1)
        finally:
            agent.fetch_and_verify_release = real
        self.assertEqual(self.status_json()["status"], "failed")
        self.assertEqual(self.ref(), REF_A)
        self.assertNotIn("restart", self.calls())

    def _interrupted(self, pin, inflight):
        os.makedirs(self.status, exist_ok=True)
        os.chmod(self.status, 0o755)
        self.write("etc/polynovea.env", f"POLYNOVEA_IMAGE_REF={pin}\n")
        self.write("status/status.json", json.dumps({"schema": 1, "releaseId": RELEASE_B, "fromRelease": RELEASE_A, "status": "running",
                                                     "startedAt": "2026-11-24T00:00:00Z", "steps": [{"step": "start", "outcome": "started", "at": "t"}]}))
        self.write("status/state.json", json.dumps({"inFlight": inflight}))

    def test_a_reboot_mid_switch_puts_the_previous_release_back(self):
        # The agent was killed after pinning B and before B passed its health check (a reboot).
        self._interrupted(REF_B, {"release": RELEASE_B, "previousRef": REF_A, "newRef": REF_B, "fromRelease": RELEASE_A,
                                  "rollback": "compatible", "phase": "started"})
        self.assertEqual(agent.main(["--recover"]), 0)  # at boot, before polynovea.service
        status = self.status_json()
        self.assertEqual(status["status"], "rolled_back")
        self.assertIn(("resume", "started"), [(s["step"], s["outcome"]) for s in status["steps"]])
        self.assertEqual(self.ref(), REF_A)
        self.assertNotIn("restart", self.calls())  # polynovea.service starts it after this unit
        state = json.loads(read(os.path.join(self.status, "state.json")))
        self.assertNotIn("inFlight", state)
        self.assertEqual(state["failures"][RELEASE_B], 1)

    def test_a_reboot_after_migrations_in_restore_mode_restores_the_database(self):
        self._interrupted(REF_A, {"release": RELEASE_B, "previousRef": REF_A, "newRef": REF_B, "fromRelease": RELEASE_A,
                                  "rollback": "restore", "phase": "migrated", "backupKind": "pgbackrest",
                                  "backupLabel": "20261124-010101F", "lsn": "0/3000060"})
        self.request()  # a new request arrives; the interrupted upgrade is finished first
        self.run_agent()
        self.assertIn("system restore-backup --set 20261124-010101F --lsn 0/3000060", self.calls())

    def test_nothing_to_recover_is_a_no_op(self):
        self.assertEqual(agent.main(["--recover"]), 0)
        self.assertEqual(self.calls(), "")

    # ── (5) compose runtime ──────────────────────────────────────────────────────────────────────
    def test_compose_runtime_picks_up_a_request_and_reports_status(self):
        compose = os.path.join(self.root, "compose")
        os.makedirs(compose)
        self.write("compose/.env", f"POLYNOVEA_DOMAIN=cms.example.com\nPOLYNOVEA_IMAGE={REF_A}\n")
        extra = {"POLYNOVEA_UPGRADE_RUNTIME": "compose", "POLYNOVEA_UPGRADE_COMPOSE_DIR": compose,
                 "POLYNOVEA_UPGRADE_CONTAINER": "polynovea-cms-1", "POLYNOVEA_UPGRADE_SERVICE": "cms",
                 "POLYNOVEA_UPGRADE_COMPOSE_PROFILE": "proxy"}
        os.environ.update(extra)
        try:
            self.request()
            self.assertEqual(self.run_agent(), 0)
        finally:
            for key in extra:
                os.environ.pop(key, None)
        self.assertEqual(self.status_json()["status"], "succeeded")
        self.assertIn(f"POLYNOVEA_IMAGE={REF_B}", read(os.path.join(compose, ".env")))
        self.assertIn("POLYNOVEA_DOMAIN=cms.example.com", read(os.path.join(compose, ".env")))
        calls = self.calls()
        self.assertIn(f"compose --project-directory {compose} -p polynovea --profile proxy up -d --no-deps --force-recreate cms", calls)
        self.assertIn("--volumes-from polynovea-cms-1", calls)

    def test_https_only_channel(self):
        self.assertFalse(agent._channel_url_ok("http://releases.example.com/x", False))
        self.assertFalse(agent._channel_url_ok("https://user:pw@releases.example.com/x", False))
        self.assertTrue(agent._channel_url_ok("https://releases.example.com/x", False))
        self.assertFalse(agent._channel_url_ok("http://10.0.0.1/x", True))


if __name__ == "__main__":
    if sys.platform != "linux":
        sys.exit("run on Linux (WSL or a container)")
    unittest.main(verbosity=1)
