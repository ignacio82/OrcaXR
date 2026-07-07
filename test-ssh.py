import pexpect
import sys

child = pexpect.spawn('ssh -v -o StrictHostKeyChecking=no root@192.168.1.228', encoding='utf-8')
index = child.expect(['[P|p]assword:', pexpect.EOF, pexpect.TIMEOUT], timeout=10)
if index == 0:
    child.sendline('snapmaker')
    child.expect(pexpect.EOF)
    print(child.before)
else:
    print(child.before)
