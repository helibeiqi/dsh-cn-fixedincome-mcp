#!/usr/bin/env python3
"""dsh-cn-fixedincome-mcp 自测：驱动完整 MCP 握手 + 逐工具断言关键字段。"""
import subprocess, json, sys, os

NODE = r"C:\Users\helib\.workbuddy\binaries\node\versions\22.22.2-2\node.exe"
SERVER = os.path.join(os.path.dirname(__file__), "fixedincome-mcp-server.mjs")

proc = subprocess.Popen([NODE, SERVER], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, bufsize=1)

def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()

def read_until_id(want_id, timeout_lines=200):
    for _ in range(timeout_lines):
        line = proc.stdout.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if msg.get("id") == want_id:
            return msg
    return None

results = []
def check(name, cond, detail=""):
    results.append((name, cond, detail))
    print(("PASS" if cond else "FAIL"), name, detail if not cond else "")

rid = 0
def rpc(method, params=None):
    global rid
    rid += 1
    send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
    return rid, read_until_id(rid)

# 1) initialize
i, m = rpc("initialize", {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "selftest", "version": "0"}})
check("initialize returns serverInfo", m and "result" in m and "serverInfo" in m["result"], str(m)[:120])
check("serverInfo name = dsh-cn-fixedincome-mcp", m and m["result"]["serverInfo"]["name"] == "dsh-cn-fixedincome-mcp")

# 2) tools/list
i, m = rpc("tools/list")
tools = m["result"]["tools"]
check("tools/list returns 6 tools", len(tools) == 6, f"got {len(tools)}")
names = {t["name"] for t in tools}
check("tools include cb_analytics/cb_lookup/cb_screen/bond_ytm/bond_metrics/bond_cashflow",
      {"cb_analytics","cb_lookup","cb_screen","bond_ytm","bond_metrics","bond_cashflow"} <= names)

# 3) cb_analytics (explicit terms)
i, m = rpc("tools/call", {"name": "cb_analytics", "arguments": {
    "stock_price": 10, "conversion_price": 20, "bond_price": 110, "par": 100,
    "coupon_rates": [0.2,0.4,0.6,0.8,1.6,2.0], "years_to_maturity": 6, "maturity_redemption": 110}})
r = json.loads(m["result"]["content"][0]["text"])
check("cb_analytics conversion_value=50", r["conversion_value"] == 50.0, str(r.get("conversion_value")))
check("cb_analytics conversion_premium_rate=120", r["conversion_premium_rate"] == 120.0, str(r.get("conversion_premium_rate")))
check("cb_analytics double_low=230", r["double_low"] == 230.0, str(r.get("double_low")))
check("cb_analytics ytm present (~0.84%)", r.get("ytm") is not None and 0.5 < r["ytm"] < 1.5, str(r.get("ytm")))
check("cb_analytics clause_flags present", "clause_flags" in r and "downward_revision" in r["clause_flags"])

# 4) cb_analytics via code (seed load)
i, m = rpc("tools/call", {"name": "cb_analytics", "arguments": {"code": "113050"}})
r = json.loads(m["result"]["content"][0]["text"])
check("cb_analytics code=113050 returns conversion_value", isinstance(r.get("conversion_value"), (int, float)), str(r)[:120])

# 5) cb_lookup
i, m = rpc("tools/call", {"name": "cb_lookup", "arguments": {"query": "113050"}})
r = json.loads(m["result"]["content"][0]["text"])
check("cb_lookup found", r.get("found") is True, str(r)[:120])
check("cb_lookup terms.conversion_price present", "terms" in r and r["terms"].get("conversion_price") is not None)

# 6) cb_screen
i, m = rpc("tools/call", {"name": "cb_screen", "arguments": {"max_premium_rate": 200}})
r = json.loads(m["result"]["content"][0]["text"])
check("cb_screen returns rows", r.get("count", 0) > 0, str(r.get("count")))
if r.get("rows"):
    dl = [x["double_low"] for x in r["rows"]]
    check("cb_screen sorted by double_low asc", dl == sorted(dl), str(dl))

# 7) bond_ytm
i, m = rpc("tools/call", {"name": "bond_ytm", "arguments": {
    "price": 110, "coupon_rates": [0.2,0.4,0.6,0.8,1.6,2.0], "years": 6, "redemption": 110}})
r = json.loads(m["result"]["content"][0]["text"])
check("bond_ytm ~0.84%", abs(r["ytm"] - 0.84) < 0.2, str(r.get("ytm")))

# 8) bond_metrics
i, m = rpc("tools/call", {"name": "bond_metrics", "arguments": {
    "price": 110, "ytm": 0.84, "cashflows": [
        {"t":1,"amount":0.2},{"t":2,"amount":0.4},{"t":3,"amount":0.6},{"t":4,"amount":0.8},{"t":5,"amount":1.6},{"t":6,"amount":112}]}})
r = json.loads(m["result"]["content"][0]["text"])
check("bond_metrics macaulay present", r.get("macaulay") is not None, str(r.get("macaulay")))
check("bond_metrics dv01 present", r.get("dv01") is not None, str(r.get("dv01")))

# 9) bond_cashflow
i, m = rpc("tools/call", {"name": "bond_cashflow", "arguments": {
    "coupon_rates": [0.2,0.4], "years": 2, "redemption": 106}})
r = json.loads(m["result"]["content"][0]["text"])
check("bond_cashflow 2 entries", len(r["cashflows"]) == 2, str(len(r.get("cashflows", []))))
check("bond_cashflow final = coupon+redemption (106.4)", r["cashflows"][-1]["amount"] == 106.4)

proc.terminate()
passed = sum(1 for _, c, _ in results if c)
print(f"\n{passed}/{len(results)} checks passed")
sys.exit(0 if passed == len(results) else 1)
