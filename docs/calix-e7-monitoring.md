# Calix E7 optical monitoring — least‑privilege account

Open Fiber Map polls a Calix E7 (AXOS) over **SSH** and only ever runs **read‑only
`show` commands** to read optical light levels:

- `show ont detail` — per‑ONT receive/transmit power
- `show interface ethernet module` — uplink SFP/QSFP Rx/Tx power + temperature

It never changes configuration. So the monitoring login should be a dedicated,
**read‑only** account — not `sysadmin`. On AXOS the built‑in read‑only role is
**`oper`** (it can run `show` commands but cannot enter config or change anything).

> Best practice: one purpose‑built monitoring account per OSS/tool, read‑only,
> strong unique password, rotated periodically. Never put an admin/`sysadmin`
> credential into a monitoring system.

## Create the account (AXOS R2x–R26)

SSH to the E7 as an admin user and create a read‑only (`oper`) user:

```
ssh sysadmin@<e7-ip>

config
aaa user ofm-monitor password <choose-a-strong-password> role oper
end
```

That's it — AXOS applies the change immediately (the running‑config is persistent;
no separate "save" is needed). Available roles on this platform are
`admin`, `networkadmin`, `oper`, `calixsupport`, `ontdebug` — use **`oper`**.

Username rules: 3–16 chars, pattern `[a-z_][a-z0-9_-]*`. Password: 3–32 chars
(use a long random one).

### Verify

```
show aaa user local-role          # confirm ofm-monitor exists with role oper
```

Then from another terminal, confirm the new account can read but not write:

```
ssh ofm-monitor@<e7-ip>
show ont detail | include opt-signal-level     # should work
config                                         # should be denied / unavailable
```

## Use it in Open Fiber Map

On the equipment's **Monitor** modal:

| Field | Value |
|-------|-------|
| Vendor / source | **Calix E7 (SSH CLI)** |
| Host / IP | the E7 management IP |
| Port | **22** |
| Username | `ofm-monitor` |
| Password | the password you set |
| Auto‑poll interval | e.g. `300` (seconds), or `0` for manual only |

The password is stored encrypted (AES‑256‑GCM). Click **Poll now** to test;
optical levels populate per port (uplink readings auto‑link to ports named
`1/1/x1`, `1/2/q1`, … ; ONT readings are keyed by ONT serial).

## Optional hardening

- **Reach the E7 over SSH only** (disable Telnet/unused mgmt services).
- **Restrict management access** with the E7 management ACL so only the Open
  Fiber Map server's IP can reach SSH.
- **Tighter than `oper` (advanced):** AXOS RBAC can define a custom rule‑list that
  permits *only* the two `show` commands this tool uses and denies everything
  else, then bind the user to that group and `apply rbac-aaa`. `oper` is the
  simple, supported best‑practice baseline; a custom rule‑list is only worth it
  if your policy requires command‑level restriction.
- **Rotate** the monitoring password on your normal cadence and update it in the
  Monitor modal (leave the field blank when editing to keep the existing one).
