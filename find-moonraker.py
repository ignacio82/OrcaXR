import pexpect
import sys

def run():
    try:
        child = pexpect.spawn('ssh -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
        index = child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        if index != 0:
            print("Failed to connect or no password prompt")
            sys.exit(1)
            
        child.sendline('snapmaker')
        child.expect(['# ', '\$ '])
        
        # Check running Moonraker process to see which config file it uses
        child.sendline('ps -ef | grep moonraker | grep -v grep')
        child.expect(['# ', '\$ '])
        print("Moonraker process:")
        print(child.before)
        
        # Find all moonraker.conf files
        child.sendline('find / -name "moonraker.conf*" 2>/dev/null')
        child.expect(['# ', '\$ '])
        print("All moonraker.conf files:")
        print(child.before)
        
        child.sendline('exit')
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

run()
