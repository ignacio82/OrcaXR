"""Offline checks: never contact a printer or print authentication literals."""

import ast
from pathlib import Path
import unittest
from unittest.mock import patch

from maintenance_ssh import SshSession

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = (
    "check-config.py", "find-moonraker.py", "fix-moonraker.py",
    "fix-webcam-cors.py", "ls-moonraker.py", "setup-moonraker.py", "test-ssh.py",
)


class MaintenanceSecurity(unittest.TestCase):
    def test_default_uses_only_keys_with_verified_hosts(self):
        args = SshSession("printer.local", "operator").argv("id")
        self.assertIn("StrictHostKeyChecking=yes", args)
        self.assertIn("BatchMode=yes", args)
        self.assertIn("PreferredAuthentications=publickey", args)
        self.assertIn("ForwardAgent=no", args)
        self.assertEqual(args[-2:], ["printer.local", "id"])

    def test_password_is_owned_by_openssh_hidden_terminal_prompt(self):
        args = SshSession("printer.local", "operator", interactive_password=True).argv("id")
        self.assertIn("BatchMode=no", args)
        self.assertIn("NumberOfPasswordPrompts=1", args)
        self.assertIn("StrictHostKeyChecking=yes", args)

    def test_explicit_identity_and_host_file_remain_single_arguments(self):
        args = SshSession("::1", "operator", port=2222, identity="/keys/my key",
                          known_hosts="/keys/verified hosts").argv("printf done")
        self.assertIn("/keys/my key", args)
        self.assertIn("UserKnownHostsFile=/keys/verified hosts", args)
        with patch("maintenance_ssh.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = "done"
            self.assertEqual(SshSession("printer.local", "operator").run("printf done"), "done")
            self.assertNotIn("shell", run.call_args.kwargs)
            self.assertNotIn("input", run.call_args.kwargs)

    def test_rejects_ssh_option_and_shell_injection_in_identity(self):
        for host, user in [("-oProxyCommand=bad", "root"), ("printer;id", "root"),
                           ("printer", "-bad"), ("printer", "root\nother")]:
            with self.assertRaises(ValueError):
                SshSession(host, user)

    def test_failures_do_not_replay_authentication_output(self):
        with patch("maintenance_ssh.subprocess.run") as run:
            run.return_value.returncode = 255
            run.return_value.stderr = "private authentication output"
            with self.assertRaises(RuntimeError) as raised:
                SshSession("printer.local", "operator").run("id")
            self.assertNotIn("private authentication output", str(raised.exception))

    def test_scripts_share_authentication_and_have_no_embedded_secrets(self):
        for name in (*SCRIPTS, "maintenance_ssh.py"):
            with self.subTest(script=name):
                source = (ROOT / name).read_text()
                tree = ast.parse(source)
                # Report locations only; a failed scan must not echo a secret.
                violations = []
                for node in ast.walk(tree):
                    if isinstance(node, ast.Constant) and isinstance(node.value, str):
                        if any(value in node.value for value in (
                            "StrictHostKeyChecking=no", "UserKnownHostsFile=/dev/null",
                            "sshpass", "AutoAddPolicy",
                        )):
                            violations.append(node.lineno)
                    if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant):
                        if any(isinstance(t, ast.Name) and any(s in t.id.lower() for s in
                               ("password", "secret", "token")) for t in node.targets):
                            violations.append(node.lineno)
                    if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                        if node.func.attr in ("sendline", "spawn", "connect"):
                            violations.append(node.lineno)
                self.assertFalse(violations, f"Unsafe authentication at {name}:{violations}")
                if name != "maintenance_ssh.py":
                    self.assertTrue(any(isinstance(n, ast.ImportFrom) and n.module == "maintenance_ssh"
                                        for n in tree.body), f"{name} must use the shared SSH helper")


if __name__ == "__main__":
    unittest.main()
