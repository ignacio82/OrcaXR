import pexpect
import sys

child = pexpect.spawn('ssh -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
child.sendline('snapmaker')
child.expect(['# ', '\$ '])

# Check moonraker service to find config path
child.sendline('systemctl status moonraker -l')
child.expect(['# ', '\$ '])
print("Moonraker Status:\n" + child.before)

# Check the file we edited
child.sendline('cat /home/lava/origin_printer_data/config/moonraker.conf | grep -A 5 cors_domains')
child.expect(['# ', '\$ '])
print("Edited Config:\n" + child.before)

child.sendline('exit')
