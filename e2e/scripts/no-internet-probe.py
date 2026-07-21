import socket

sock = socket.socket()
sock.settimeout(5)

try:
    sock.connect(("1.1.1.1", 80))
    print("CONNECTED")
except OSError as error:
    print("BLOCKED:" + type(error).__name__)
finally:
    sock.close()
