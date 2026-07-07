import pexpect
import sys

def run():
    try:
        child = pexpect.spawn('ssh -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
        child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        child.sendline('snapmaker')
        child.expect(['# ', '\$ '])
        
        # List the contents of /home/lava/printer_data/config/
        child.sendline('ls -la /home/lava/printer_data/config/')
        child.expect(['# ', '\$ '])
        print("Config directory contents:")
        print(child.before)
        
        # Check if moonraker.conf is a symlink or exists there
        child.sendline('cat /home/lava/printer_data/config/moonraker.conf | grep -A 5 cors_domains')
        child.expect(['# ', '\$ '])
        print("moonraker.conf cors_domains:")
        print(child.before)
        
        child.sendline('exit')
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

run()
