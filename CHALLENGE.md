# Green Status, Red Checkout

The branch store's operations dashboard says the data center is healthy. Customers, however, cannot complete checkout after a primary WAN failure. Your team has an OSPF backup path, and the status service still responds. Investigate why only the payment service fails, then restore checkout without bringing the failed link back up.

The two named servers stand in for those services. Use ping to test their network reachability; no checkout software is installed in this simulator.

## Mission

1. Wait for OSPF to converge. On BRANCH, confirm that both neighbors are FULL and the server subnet is in the route table. Then, from STORE-PC, establish a baseline by testing `10.60.10.20` (STATUS-SRV) and `10.60.10.10` (PAYMENT-SRV).
2. Simulate the incident by shutting the PRIMARY router's `GigabitEthernet0/1` interface toward DATACENTER.
3. Repeat both tests. Record what differs, including any reply text.
4. Inspect routing on BRANCH and explain why the backup path works for one server but not the other.
5. Make the smallest routing change that restores payment while leaving the failed link down. Retest both services.

## Evidence to present

- Baseline and post-failure results for both servers.
- The BRANCH routing entries relevant to the server LAN and payment server.
- The configuration change and the successful payment retest.
- A short incident summary explaining why status monitoring did not catch the customer-facing outage, plus one monitoring improvement.

**Success criterion:** Payment and status both respond while PRIMARY's data-center interface remains shut. Do not solve the exercise by turning that interface back on.

After the repair, explain whether increasing a static route's administrative distance above 110 would make an OSPF `/24` win over an installed static `/32`. Identify which part of route selection that setting actually controls.
