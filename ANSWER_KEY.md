# Facilitator answer key — Green Status, Red Checkout

This file contains the solution. In Sandbox, import [lab-files/green-status-red-checkout.json](lab-files/green-status-red-checkout.json), then select **Open** beside the imported entry in the saved list.

The payment/status names are the incident story. The measured outcome is ICMP reachability, not a real payment transaction. Recorded command output is in [verification/](verification/).

## Run and verify

Before taking the baseline, run `show ip ospf neighbor` and `show ip route` on BRANCH in privileged EXEC mode. Wait for both neighbors to reach FULL and for the OSPF route to `10.60.10.0/24` to appear. A newly opened lab can briefly return destination-unreachable messages during convergence.

On STORE-PC, open Desktop → Command Prompt and run:

```text
ping 10.60.10.20
ping 10.60.10.10
```

Both should reply. On PRIMARY, use the CLI to fail the data-center link:

```text
enable
configure terminal
interface GigabitEthernet0/1
shutdown
end
```

Repeat both pings on STORE-PC. STATUS-SRV should still reply over the backup path. PAYMENT-SRV should show `Reply from 10.0.1.2: TTL expired in transit` and 100% packet loss in this simulator.

On BRANCH, inspect routing:

```text
enable
show ip route
```

Look for the OSPF route to `10.60.10.0/24` via `10.0.2.2` and the static host route to `10.60.10.10/32` via `10.0.1.2`. The `/32` is the more-specific match for PAYMENT-SRV, regardless of OSPF's normal failover route to the larger subnet. With PRIMARY's data-center link down, traffic for that host loops between BRANCH and PRIMARY until TTL expires.

On PRIMARY, `show ip route` should show the server subnet through `10.0.1.1`, BRANCH's address. These two entries prove the loop: BRANCH sends the payment host to PRIMARY, and PRIMARY sends that subnet back to BRANCH. The live test recorded metrics 101 on BRANCH through BACKUP and 111 on PRIMARY through BRANCH.

Remove only that stale exception on BRANCH:

```text
configure terminal
no ip route 10.60.10.10 255.255.255.255 10.0.1.2
end
show ip route
```

Retest `ping 10.60.10.10` from STORE-PC. It should return four replies even though PRIMARY's `GigabitEthernet0/1` remains down. The live Sandbox test produced 4/4 replies after this repair.

## Incident explanation

The primary link failure triggers OSPF reconvergence, but the payment host has an old static `/32` route on BRANCH. Longest-prefix matching selects that route over OSPF's `10.60.10.0/24` route. STATUS-SRV has no host-specific exception, so it uses the backup path and remains reachable. A single green status ping therefore masks a checkout outage. The repair is to remove the obsolete payment-specific route, not to abandon the backup path or merely restart the failed link.

Raising the static route's administrative distance above 110 does not make the `/24` win while the `/32` remains installed. Administrative distance compares route sources for the same prefix; packet forwarding then uses the longest installed matching prefix. Cisco explains that distinction in [Understand Administrative Distance](https://www.cisco.com/c/en/us/support/docs/ip/border-gateway-protocol-bgp/15986-admin-distance.html).

For a production analogue, verify the intended failover design before removing a route, change it under normal change control, and monitor the actual checkout transaction from the branch or customer edge—not only a generic status endpoint.

## Return the running canvas to the starting state (optional)

If you want to replay the challenge in the current running canvas, re-add the original static route on BRANCH and restore PRIMARY's interface:

```text
BRANCH# configure terminal
BRANCH(config)# ip route 10.60.10.10 255.255.255.255 10.0.1.2
BRANCH(config)# end

PRIMARY# configure terminal
PRIMARY(config)# interface GigabitEthernet0/1
PRIMARY(config-if)# no shutdown
PRIMARY(config-if)# end
```

Alternatively, re-import the original JSON and open that saved entry to start fresh. The saved import file already includes the healthy link and stale route. Changes in a CLI affect the running configuration; if you are keeping a repaired copy, save it separately after verifying it so the starter remains available.
