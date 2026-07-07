import pexpect
import sys

def run():
    try:
        child = pexpect.spawn('ssh -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
        child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        child.sendline('snapmaker')
        child.expect(['# ', '\$ '])
        
        conf_path = '/home/lava/printer_data/config/moonraker.conf'
        
        # Add the domains to the active config
        sed_cmd = f"sed -i '/cors_domains:/a \\    https://orcaxr.martinez.fyi\\n    http://orcaxr.martinez.fyi' {conf_path}"
        child.sendline(sed_cmd)
        child.expect(['# ', '\$ '])
        
        print("Restarting Moonraker...")
        child.sendline('systemctl restart moonraker || service moonraker restart')
        child.expect(['# ', '\$ '], timeout=15)
        print("Done.")
        
        # Verify the edit
        child.sendline(f'cat {conf_path} | grep -A 5 cors_domains')
        child.expect(['# ', '\$ '])
        print("Verified Config:")
        print(child.before)
        
        child.sendline('exit')
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

run()
