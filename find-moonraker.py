"""Locate Moonraker processes and configuration files."""
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    print('Moonraker process:')
    print(ssh.run('ps -ef | grep moonraker | grep -v grep'))
    print('All moonraker.conf files:')
    print(ssh.run('find / -name "moonraker.conf*" 2>/dev/null'))


if __name__ == '__main__':
    run()
