"""Hold small TCP receive windows to reproduce preview backpressure."""
import http.client
import json
import re
import socket
import sys
import time

asset = sys.argv[1]
if not re.fullmatch(r"[a-f0-9-]{36}", asset):
    raise ValueError("Asset UUID required")
with open("/fixture.json") as source:
    cookie = json.load(source)["users"][0]["cookie"]

def api(route, authenticated=False):
    connection = http.client.HTTPConnection("api", 3001, timeout=3)
    try:
        connection.request("GET", route, headers={"Cookie": cookie} if authenticated else {})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()

held, statuses = [], []
try:
    for _ in range(32):
        client = socket.socket()
        client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        client.settimeout(3)
        client.connect(("api", 3002))
        held.append(client)
        client.sendall(f"GET /preview/{asset} HTTP/1.1\r\nHost: api:3002\r\nConnection: close\r\n\r\n".encode())
        headers = b""
        while not headers.endswith(b"\r\n\r\n"):
            chunk = client.recv(1)
            if not chunk:
                raise IOError("Preview closed before response headers")
            headers += chunk
        statuses.append(int(headers.split(b" ")[1]))
    time.sleep(.3)
    health_status, _ = api("/api/v1/health")
    overview_status, counters = api("/api/v1/admin/overview", True)
finally:
    for client in held:
        client.close()
time.sleep(.5)
recovered_status, recovered = api("/api/v1/admin/overview", True)
print(json.dumps(dict(healthStatus=health_status, overviewStatus=overview_status,
                     previewCodes=statuses, inflightDuringOverview=counters.get("inflight"),
                     recoveredOverviewStatus=recovered_status,
                     recoveredInflightDuringOverview=recovered.get("inflight"))))
