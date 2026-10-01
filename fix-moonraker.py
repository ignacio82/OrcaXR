"""Add the OrcaXR origins to the active Moonraker configuration."""
import shlex
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    conf_path = shlex.quote('/home/lava/printer_data/config/moonraker.conf')
    sed_cmd = f"sed -i '/cors_domains:/a \\    https://orcaxr.martinez.fyi\\n    http://orcaxr.martinez.fyi' {conf_path}"
    ssh.run(sed_cmd)
    print("Restarting Moonraker...")
    ssh.run('/etc/init.d/S61moonraker restart || curl -fsS -X POST http://localhost:7125/server/restart')
    print("Verified Config:")
    print(ssh.run(f'grep -A 5 cors_domains {conf_path}'))


if __name__ == '__main__':
    run()
