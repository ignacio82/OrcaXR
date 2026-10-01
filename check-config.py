"""Inspect the Moonraker service and configured CORS origins."""
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    print('Moonraker Status:')
    print(ssh.run('systemctl status moonraker -l --no-pager'))
    print('Edited Config:')
    print(ssh.run('grep -A 5 cors_domains /home/lava/origin_printer_data/config/moonraker.conf'))


if __name__ == '__main__':
    run()
