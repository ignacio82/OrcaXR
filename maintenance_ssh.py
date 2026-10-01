"""Shared OpenSSH boundary for the explicit, operator-run maintenance tools.

OpenSSH owns authentication: keys/agent by default, and its hidden terminal
prompt with --password. Credentials never enter Python, argv, or tool logs.
The host must already be verified in known_hosts; unknown/changed keys fail.
"""

import argparse
from dataclasses import dataclass
import re
import subprocess


@dataclass(frozen=True)
class SshSession:
    host: str
    username: str
    port: int = 22
    identity: str | None = None
    known_hosts: str | None = None
    interactive_password: bool = False

    def __post_init__(self):
        if not re.fullmatch(r"[A-Za-z0-9:][A-Za-z0-9.:%_-]*", self.host):
            raise ValueError("Use a hostname or IP address without a scheme or username")
        if not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]*", self.username):
            raise ValueError("Invalid SSH username")
        if not 1 <= self.port <= 65535:
            raise ValueError("SSH port must be between 1 and 65535")

    def argv(self, command: str) -> list[str]:
        args = [
            "ssh", "-T", "-p", str(self.port), "-l", self.username,
            "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10",
            "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
            "-o", "NumberOfPasswordPrompts=1",
            "-o", "BatchMode=" + ("no" if self.interactive_password else "yes"),
            "-o", "PreferredAuthentications=" + (
                "publickey,keyboard-interactive,password" if self.interactive_password else "publickey"
            ),
        ]
        if self.identity:
            args += ["-i", self.identity]
        if self.known_hosts:
            args += ["-o", "UserKnownHostsFile=" + self.known_hosts]
        return args + [self.host, command]

    def run(self, command: str, *, timeout: int = 60) -> str:
        # With --password ssh reads /dev/tty itself with terminal echo disabled.
        # Never capture or replay an authentication conversation in Python.
        result = subprocess.run(self.argv(command), capture_output=True, text=True, timeout=timeout)
        if result.returncode:
            raise RuntimeError(
                f"SSH command failed (exit {result.returncode}). Check the verified host key, "
                "SSH access, and remote command. Use --password for an interactive login."
            )
        return result.stdout


def session_from_cli(description: str) -> SshSession:
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--host", required=True, help="Explicit printer hostname or IP")
    parser.add_argument("--username", required=True, help="Explicit SSH account")
    parser.add_argument("--port", type=int, default=22)
    parser.add_argument("--identity", help="Private-key path; otherwise use SSH keys/agent")
    parser.add_argument("--known-hosts", help="Verified known_hosts file; defaults to OpenSSH configuration")
    parser.add_argument("--password", action="store_true", help="Allow OpenSSH's hidden terminal password prompt")
    args = parser.parse_args()
    return SshSession(args.host, args.username, args.port, args.identity, args.known_hosts, args.password)
