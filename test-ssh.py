"""Check verified SSH access without changing the printer."""
from maintenance_ssh import session_from_cli


def run():
    ssh = session_from_cli(__doc__)
    print('SSH connection succeeded:')
    print(ssh.run('id'))


if __name__ == '__main__':
    run()
