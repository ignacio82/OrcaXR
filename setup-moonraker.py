import pexpect
import sys

def run():
    try:
        child = pexpect.spawn('ssh -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
        index = child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
        if index != 0:
            print("Failed to get password prompt.")
            sys.exit(1)
            
        child.sendline('snapmaker')
        
        # Wait for shell prompt (usually ends with '#' for root or '$' for user)
        index = child.expect(['# ', '\$ '], timeout=10)
        
        print("Logged in successfully.")
        
        child.sendline('find / -name moonraker.conf -type f 2>/dev/null | grep -v "/var/lib" | head -n 1')
        child.expect(['# ', '\$ '])
        output = child.before.strip()
        lines = output.split('\n')
        conf_path = None
        for line in lines:
            if 'moonraker.conf' in line:
                conf_path = line.strip()
                break
                
        if not conf_path:
            print("Could not find moonraker.conf")
            sys.exit(1)
            
        print(f"Found config at: {conf_path}")
        
        child.sendline(f'grep "orcaxr.martinez.fyi" {conf_path}')
        child.expect(['# ', '\$ '])
        
        if 'orcaxr.martinez.fyi' in child.before:
            print("Domain already exists in config.")
        else:
            # We need to insert the domain right after cors_domains:
            sed_cmd = f"sed -i '/cors_domains:/a \\    https://orcaxr.martinez.fyi' {conf_path}"
            child.sendline(sed_cmd)
            child.expect(['# ', '\$ '])
            print("Modified config to add domain.")
            
        print("Restarting Moonraker...")
        child.sendline('systemctl restart moonraker || service moonraker restart || /etc/init.d/moonraker restart')
        child.expect(['# ', '\$ '], timeout=15)
        print("Moonraker restarted successfully.")
        
        child.sendline('exit')
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

run()
