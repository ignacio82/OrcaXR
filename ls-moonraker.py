"""Inspect the active Moonraker configuration directory."""
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    print('Config directory contents:')
    print(ssh.run('ls -la /home/lava/printer_data/config/'))
    print('moonraker.conf cors_domains:')
    print(ssh.run('grep -A 5 cors_domains /home/lava/printer_data/config/moonraker.conf'))


if __name__ == '__main__':
    run()
