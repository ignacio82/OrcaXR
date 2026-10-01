"""Find Moonraker configuration and allow the hosted OrcaXR origin."""
import shlex
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    output = ssh.run('find / -name moonraker.conf -type f 2>/dev/null | grep -v "/var/lib" | head -n 1')
    paths = [line.strip() for line in output.splitlines() if line.strip().startswith('/')]
    if not paths:
        raise RuntimeError("Could not find moonraker.conf")
    conf_path = shlex.quote(paths[0])
    print(f"Found config at: {paths[0]}")
    # grep's no-match status is expected; an SSH failure still fails the command.
    existing = ssh.run(f'grep "orcaxr.martinez.fyi" {conf_path} || test $? = 1')
    if 'orcaxr.martinez.fyi' in existing:
        print("Domain already exists in config.")
    else:
        ssh.run(f"sed -i '/cors_domains:/a \\    https://orcaxr.martinez.fyi' {conf_path}")
        print("Modified config to add domain.")
    print("Restarting Moonraker...")
    ssh.run('/etc/init.d/S61moonraker restart || curl -fsS -X POST http://localhost:7125/server/restart')
    print("Moonraker restarted successfully.")


if __name__ == '__main__':
    run()
