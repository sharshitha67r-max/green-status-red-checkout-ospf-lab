// Build and check the Sandbox snapshot using only files in this repository.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'lab-files', 'green-status-red-checkout.json');

function insist(condition, message) {
  if (!condition) throw new Error(message);
}

function ipv4(value) {
  const parts = value.split('.');
  insist(parts.length === 4 && parts.every(part => /^(0|[1-9]\d*)$/.test(part) && Number(part) <= 255), `Invalid IPv4 address: ${value}`);
  return parts.reduce((address, part) => (address * 256 + Number(part)) >>> 0, 0);
}

function prefixLength(mask) {
  const bits = ipv4(mask).toString(2).padStart(32, '0');
  insist(/^1*0*$/.test(bits), `Noncontiguous subnet mask: ${mask}`);
  return bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
}

function inSubnet(address, network, mask) {
  return ((ipv4(address) & ipv4(mask)) >>> 0) === ((ipv4(network) & ipv4(mask)) >>> 0);
}

function parseRouter(text, source) {
  const config = { hostname: '', interfaces: {}, ospf: [], staticRoutes: [], routerId: '', networks: [], passive: new Set() };
  let section = '';
  let sawOspf = false;
  const fail = (number, line) => { throw new Error(`${source}:${number}: unsupported or misplaced command: ${line}`); };
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line === '!' || line.startsWith('#')) continue;
    if (['enable', 'configure terminal', 'end', 'copy running-config startup-config'].includes(line)) { section = ''; continue; }
    if (line === 'exit') { insist(section, `${source}:${index + 1}: exit outside a configuration section`); section = ''; continue; }
    let match;
    if ((match = /^hostname ([A-Za-z0-9-]+)$/.exec(line)) && !section) {
      insist(!config.hostname, `${source}: duplicate hostname`);
      config.hostname = match[1];
    } else if ((match = /^interface (GigabitEthernet\d+\/\d+)$/.exec(line)) && !section) {
      insist(!config.interfaces[match[1]], `${source}: duplicate interface block ${match[1]}`);
      section = match[1];
      config.interfaces[section] = { commands: [], cost: 1, up: false };
    } else if (line === 'router ospf 1' && !section) {
      insist(!sawOspf, `${source}: duplicate OSPF block`);
      sawOspf = true;
      section = 'ospf';
    } else if ((match = /^ip route (\S+) (\S+) (\S+)(?: (\d+))?$/.exec(line)) && !section) {
      const [, destination, mask, nextHop, distance = '1'] = match;
      ipv4(destination); prefixLength(mask); ipv4(nextHop);
      insist(((ipv4(destination) & ipv4(mask)) >>> 0) === ipv4(destination), `${source}: static route destination is not a network address`);
      insist(Number(distance) >= 1 && Number(distance) <= 255, `${source}: invalid static route distance`);
      config.staticRoutes.push({ destination, mask, nextHop, distance: Number(distance), command: line });
    } else if (section === 'ospf') {
      if ((match = /^router-id (\S+)$/.exec(line))) {
        insist(!config.routerId, `${source}: duplicate router ID`);
        ipv4(match[1]); config.routerId = match[1];
      } else if ((match = /^passive-interface (GigabitEthernet\d+\/\d+)$/.exec(line))) {
        insist(!config.passive.has(match[1]), `${source}: duplicate passive interface`);
        config.passive.add(match[1]);
      } else if ((match = /^network (\S+) (\S+) area (\d+)$/.exec(line))) {
        ipv4(match[1]); ipv4(match[2]);
        const mask = (~ipv4(match[2])) >>> 0;
        const maskString = [24, 16, 8, 0].map(shift => (mask >>> shift) & 255).join('.');
        prefixLength(maskString);
        config.networks.push({ network: match[1], mask: maskString, area: Number(match[3]) });
      } else fail(index + 1, line);
      config.ospf.push(line);
    } else if (config.interfaces[section]) {
      const intf = config.interfaces[section];
      if (/^description \S.*$/.test(line)) { /* Display-only interface description. */ }
      else if ((match = /^ip address (\S+) (\S+)$/.exec(line))) {
        insist(!intf.ip, `${source}: duplicate IP address on ${section}`);
        ipv4(match[1]); prefixLength(match[2]);
        intf.ip = match[1]; intf.mask = match[2];
      } else if ((match = /^ip ospf cost (\d+)$/.exec(line))) {
        insist(Number(match[1]) > 0 && Number(match[1]) <= 65535, `${source}: invalid OSPF cost`);
        intf.cost = Number(match[1]);
      } else if (line === 'no shutdown') intf.up = true;
      else if (line === 'shutdown') intf.up = false;
      else fail(index + 1, line);
      intf.commands.push(line);
    } else fail(index + 1, line);
  }
  insist(config.hostname && sawOspf && config.routerId, `${source}: hostname and OSPF router ID are required`);
  for (const passive of config.passive) insist(config.interfaces[passive], `${source}: unknown passive interface ${passive}`);
  return config;
}

const devices = [
  ['d1', 'BRANCH', 'router', 'ISR4331', 390, 350],
  ['d2', 'PRIMARY', 'router', 'ISR4331', 620, 160],
  ['d3', 'BACKUP', 'router', 'ISR4331', 620, 510],
  ['d4', 'DATACENTER', 'router', 'ISR4331', 840, 350],
  ['d5', 'SW-BRANCH', 'switch', 'WS-C2960-24TT-L', 210, 350],
  ['d6', 'SW-DC', 'switch', 'WS-C2960-24TT-L', 1030, 350],
  ['d7', 'STORE-PC', 'pc', 'PC', 60, 350],
  ['d8', 'PAYMENT-SRV', 'server', 'Server', 1210, 260],
  ['d9', 'STATUS-SRV', 'server', 'Server', 1210, 450],
];

const cables = [
  ['d7', 'FastEthernet0', 'd5', 'FastEthernet0/1'],
  ['d5', 'GigabitEthernet0/1', 'd1', 'GigabitEthernet0/2'],
  ['d1', 'GigabitEthernet0/0', 'd2', 'GigabitEthernet0/0'],
  ['d1', 'GigabitEthernet0/1', 'd3', 'GigabitEthernet0/0'],
  ['d2', 'GigabitEthernet0/1', 'd4', 'GigabitEthernet0/0'],
  ['d3', 'GigabitEthernet0/1', 'd4', 'GigabitEthernet0/1'],
  ['d4', 'GigabitEthernet0/2', 'd6', 'GigabitEthernet0/1'],
  ['d6', 'FastEthernet0/1', 'd8', 'FastEthernet0'],
  ['d6', 'FastEthernet0/2', 'd9', 'FastEthernet0'],
];

function routerRun(template, config) {
  let run = template.replace('hostname ROUTER', `hostname ${config.hostname}`);
  for (const [name, intf] of Object.entries(config.interfaces)) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`interface ${escaped}\\n[\\s\\S]*?\\n!`);
    insist(pattern.test(run), `Router template has no interface ${name}`);
    run = run.replace(pattern, `interface ${name}\n${intf.commands.map(line => ` ${line}`).join('\n')}\n!`);
  }
  const routes = config.staticRoutes.map(route => `${route.command}\n!\n`).join('');
  const routing = `router ospf 1\n${config.ospf.map(line => ` ${line}`).join('\n')}\n!\n${routes}`;
  insist(run.includes('ip forward-protocol nd'), 'Router template has no insertion marker');
  return run.replace('ip forward-protocol nd', routing + 'ip forward-protocol nd').trim().split(/\r?\n/);
}

function build() {
  const template = JSON.parse(fs.readFileSync(path.join(root, 'templates', 'sandbox-v2.json'), 'utf8'));
  insist(template.v === 1 && !Number.isNaN(Date.parse(template.exportDate)), 'Invalid Sandbox template metadata');
  const configs = {};
  const snapshot = {
    v: 2, kind: 'pmn-sandbox',
    name: 'Green Status, Red Checkout - OSPF Routing Loop',
    // Keep the source snapshot date stable so rebuilds do not create noisy diffs.
    date: template.exportDate,
    doc: {
      v: 2,
      devices: devices.map(([id, name, type, model, x, y]) => ({ id, name, type, model, x, y, on: true, ...(['pc', 'server'].includes(type) ? { boot: name } : {}) })),
      links: cables.map(([ad, ap, bd, bp], index) => ({ id: `l${index + 1}`, type: 'ethernet', a: { dev: ad, port: ap }, b: { dev: bd, port: bp } })),
      notes: [
        { id: 'n1', text: 'GREEN STATUS / RED CHECKOUT', x: 520, y: 55 },
        { id: 'n2', text: '10.50.10.10/24', x: 60, y: 435 },
        { id: 'n3', text: 'Gi0/2 10.50.10.1', x: 320, y: 465 },
        { id: 'n4', text: 'Gi0/0 10.0.1.1', x: 390, y: 275 },
        { id: 'n5', text: 'Gi0/1 10.0.2.1', x: 450, y: 440 },
        { id: 'n6', text: 'Gi0/0 10.0.1.2', x: 540, y: 120 },
        { id: 'n7', text: 'Gi0/1 10.0.3.1', x: 710, y: 120 },
        { id: 'n8', text: 'Gi0/0 10.0.2.2', x: 550, y: 600 },
        { id: 'n9', text: 'Gi0/1 10.0.4.1', x: 690, y: 600 },
        { id: 'n10', text: 'Gi0/0 10.0.3.2', x: 870, y: 275 },
        { id: 'n11', text: 'Gi0/1 10.0.4.2', x: 780, y: 465 },
        { id: 'n12', text: 'Gi0/2 10.60.10.1', x: 950, y: 465 },
        { id: 'n13', text: '10.60.10.10/24', x: 1210, y: 350 },
        { id: 'n14', text: '10.60.10.20/24', x: 1210, y: 565 },
      ],
      view: { x: 20, y: 30, zoom: 0.85 },
    },
    storage: {}, live: {},
  };
  for (const device of snapshot.doc.devices) {
    const { id, name, type } = device;
    const terminal = { screen: '', hist: [], mode: 'user', path: [], typed: '' };
    if (type === 'router') {
      const file = `configs/${name}.txt`;
      configs[id] = parseRouter(fs.readFileSync(path.join(root, file), 'utf8'), file);
      insist(configs[id].hostname === name, `${file}: hostname must match ${name}`);
      const run = routerRun(template.routerBoot, configs[id]);
      snapshot.storage[id] = structuredClone(template.routerStorage);
      snapshot.storage[id].nvram.file = run;
      snapshot.live[id] = { run, boot: template.routerBoot.replace('hostname ROUTER', `hostname ${name}`), ...terminal };
    } else if (type === 'switch') {
      const run = template.switchBoot.replace('hostname SWITCH', `hostname ${name}`).trim().split(/\r?\n/);
      snapshot.storage[id] = structuredClone(template.switchStorage);
      snapshot.storage[id].nvram.file = run;
      snapshot.live[id] = { run, boot: run.join('\n'), ...terminal };
    } else {
      const ip = id === 'd7' ? '10.50.10.10' : id === 'd8' ? '10.60.10.10' : '10.60.10.20';
      const gw = id === 'd7' ? '10.50.10.1' : '10.60.10.1';
      snapshot.storage[id] = structuredClone(template.hostStorage);
      snapshot.storage[id].host = { intf: 'FastEthernet0', v4: 'static', v6: 'static', ip, mask: '255.255.255.0', gw, ip6: '', len: '', gw6: '' };
      snapshot.live[id] = terminal;
    }
  }
  validate(snapshot, configs);
  return { snapshot, configs };
}

function validate(snapshot, configs) {
  const byId = new Map();
  const names = new Set();
  const ips = new Set();
  const routerIds = new Set();
  const occupied = new Set();
  const linkIds = new Set();
  const notes = snapshot.doc.notes.map(note => note.text);
  const claimIp = (ip, mask, where) => {
    const number = ipv4(ip); const subnetMask = ipv4(mask); const prefix = prefixLength(mask);
    insist(prefix < 31 && number !== ((number & subnetMask) >>> 0) && number !== (((number & subnetMask) | (~subnetMask)) >>> 0), `${where}: expected a usable host address`);
    insist(!ips.has(ip), `Duplicate address ${ip}`); ips.add(ip);
    insist(notes.some(note => note.includes(ip)), `${where}: missing topology IP label`);
  };
  for (const device of snapshot.doc.devices) {
    insist(!byId.has(device.id) && !names.has(device.name), `Duplicate device ID or name: ${device.name}`);
    byId.set(device.id, device); names.add(device.name);
    const storage = snapshot.storage[device.id]; const live = snapshot.live[device.id];
    insist(storage && live && live.screen === '' && live.hist.length === 0 && live.typed === '', `${device.name}: snapshot must not retain terminal history`);
    insist(storage.nvram.priv === null || Object.values(storage.nvram.priv).every(value => value === null), `${device.name}: private credentials found in snapshot`);
    if (live.run) assert.deepEqual(live.run, storage.nvram.file, `${device.name}: running/startup configs differ`);
    if (device.type === 'router') {
      const config = configs[device.id];
      insist(!routerIds.has(config.routerId), `Duplicate OSPF router ID ${config.routerId}`); routerIds.add(config.routerId);
      for (const [name, intf] of Object.entries(config.interfaces)) {
        insist(intf.ip && intf.mask, `${device.name} ${name}: missing IP configuration`);
        claimIp(intf.ip, intf.mask, `${device.name} ${name}`);
        insist(config.networks.filter(network => inSubnet(intf.ip, network.network, network.mask)).length === 1, `${device.name} ${name}: interface must match one OSPF network statement`);
      }
    } else if (['pc', 'server'].includes(device.type)) {
      const host = storage.host; claimIp(host.ip, host.mask, device.name);
      insist(inSubnet(host.ip, host.gw, host.mask), `${device.name}: gateway is outside host subnet`);
    }
  }
  for (const link of snapshot.doc.links) {
    insist(!linkIds.has(link.id), `Duplicate link ID ${link.id}`); linkIds.add(link.id);
    for (const end of [link.a, link.b]) {
      insist(byId.has(end.dev), `${link.id}: unknown device ${end.dev}`);
      const key = `${end.dev}:${end.port}`;
      insist(!occupied.has(key), `Port is cabled twice: ${key}`); occupied.add(key);
      const device = byId.get(end.dev);
      if (device.type === 'router') insist(configs[end.dev].interfaces[end.port]?.up, `${device.name} ${end.port}: linked interface must start up`);
      else if (device.type === 'switch') insist(snapshot.live[end.dev].run.includes(`interface ${end.port}`), `${device.name}: unknown port ${end.port}`);
      else insist(snapshot.storage[end.dev].host.intf === end.port, `${device.name}: cable uses wrong host port`);
    }
    if (configs[link.a.dev] && configs[link.b.dev]) {
      const a = configs[link.a.dev].interfaces[link.a.port]; const b = configs[link.b.dev].interfaces[link.b.port];
      insist(a.mask === b.mask && inSubnet(a.ip, b.ip, a.mask), `${link.id}: WAN addresses are not in the same subnet`);
      const area = end => configs[end.dev].networks.find(network => inSubnet(configs[end.dev].interfaces[end.port].ip, network.network, network.mask)).area;
      insist(area(link.a) === area(link.b), `${link.id}: OSPF area mismatch`);
      insist(!configs[link.a.dev].passive.has(link.a.port) && !configs[link.b.dev].passive.has(link.b.port), `${link.id}: WAN OSPF interface is passive`);
    }
  }
  // Each host must reach its configured gateway through its local Layer 2 switch.
  for (const device of snapshot.doc.devices.filter(device => ['pc', 'server'].includes(device.type))) {
    const first = snapshot.doc.links.find(link => link.a.dev === device.id || link.b.dev === device.id);
    insist(first, `${device.name}: host is disconnected`);
    const switchId = first.a.dev === device.id ? first.b.dev : first.a.dev;
    insist(byId.get(switchId).type === 'switch', `${device.name}: expected a local access switch`);
    const host = snapshot.storage[device.id].host;
    const gateway = snapshot.doc.links.filter(link => link.a.dev === switchId || link.b.dev === switchId).flatMap(link => [link.a, link.b]).find(end => configs[end.dev]?.interfaces[end.port]?.ip === host.gw);
    insist(gateway && configs[gateway.dev].interfaces[gateway.port].mask === host.mask, `${device.name}: no directly connected gateway on local switch`);
    insist(configs[gateway.dev].passive.has(gateway.port), `${device.name}: LAN interface should be OSPF passive`);
  }
  for (const [id, config] of Object.entries(configs)) {
    const routeKeys = new Set();
    for (const route of config.staticRoutes) {
      const key = `${route.destination}/${route.mask}/${route.nextHop}/${route.distance}`;
      insist(!routeKeys.has(key), `${config.hostname}: duplicate static route`); routeKeys.add(key);
      const neighbor = snapshot.doc.links.some(link => {
        const local = link.a.dev === id ? link.a : link.b.dev === id ? link.b : null;
        const peer = local === link.a ? link.b : link.a;
        return local && configs[peer.dev]?.interfaces[peer.port]?.ip === route.nextHop && inSubnet(route.nextHop, config.interfaces[local.port].ip, config.interfaces[local.port].mask);
      });
      insist(neighbor, `${config.hostname}: static next hop ${route.nextHop} must be an adjacent router`);
    }
  }
  checkForwarding(snapshot, configs);
}

// This routing model checks the intended fault; it does not replace a live
// Sandbox test. It uses configured OSPF costs and longest-prefix route selection.
function checkForwarding(snapshot, configs) {
  const endpoints = Object.fromEntries(snapshot.doc.devices.map(device => [device.name, device.id]));
  const source = endpoints.BRANCH;
  const destinationRouter = endpoints.DATACENTER;
  const serverInterface = configs[destinationRouter].interfaces['GigabitEthernet0/2'];
  const serverPrefix = prefixLength(serverInterface.mask);
  const failed = new Set([`${endpoints.PRIMARY}:GigabitEthernet0/1`, `${endpoints.DATACENTER}:GigabitEthernet0/0`]);
  function ospf(from, outage) {
    const queue = [{ node: from, cost: 0, path: [from] }]; const seen = new Set();
    while (queue.length) {
      queue.sort((a, b) => a.cost - b.cost);
      const current = queue.shift();
      if (seen.has(current.node)) continue;
      seen.add(current.node);
      if (current.node === destinationRouter) return { path: current.path, cost: current.cost + serverInterface.cost };
      for (const link of snapshot.doc.links) {
        const local = link.a.dev === current.node ? link.a : link.b.dev === current.node ? link.b : null;
        const peer = local === link.a ? link.b : link.a;
        if (!local || !configs[peer.dev] || (outage && (failed.has(`${local.dev}:${local.port}`) || failed.has(`${peer.dev}:${peer.port}`)))) continue;
        queue.push({ node: peer.dev, cost: current.cost + configs[local.dev].interfaces[local.port].cost, path: [...current.path, peer.dev] });
      }
    }
    throw new Error(`No OSPF path from ${configs[from].hostname}`);
  }
  function trace(target, outage, repaired) {
    const hops = []; let current = source;
    for (let ttl = 0; ttl < 8; ttl++) {
      if (hops.includes(current)) return { loop: true, hops: [...hops, current] };
      hops.push(current);
      if (current === destinationRouter) return { loop: false, hops };
      const matching = configs[current].staticRoutes.filter(route => inSubnet(target, route.destination, route.mask) && route.distance < 255 && !(repaired && current === source && route.destination === target && prefixLength(route.mask) === 32)).sort((a, b) => prefixLength(b.mask) - prefixLength(a.mask) || a.distance - b.distance);
      const chosen = matching.find(route => prefixLength(route.mask) > serverPrefix || (prefixLength(route.mask) === serverPrefix && route.distance < 110));
      if (chosen) {
        const neighbor = Object.entries(configs).find(([, config]) => Object.values(config.interfaces).some(intf => intf.ip === chosen.nextHop));
        insist(neighbor, `Cannot resolve static next hop ${chosen.nextHop}`); current = neighbor[0];
      } else current = ospf(current, outage).path[1];
    }
    throw new Error('Forwarding model exceeded hop limit');
  }
  const payment = snapshot.storage[endpoints['PAYMENT-SRV']].host.ip;
  const status = snapshot.storage[endpoints['STATUS-SRV']].host.ip;
  const primaryPath = [source, endpoints.PRIMARY, destinationRouter];
  const backupPath = [source, endpoints.BACKUP, destinationRouter];
  assert.deepEqual(ospf(source, false), { path: primaryPath, cost: 21 }, 'Healthy OSPF must use PRIMARY with metric 21');
  assert.deepEqual(ospf(source, true), { path: backupPath, cost: 101 }, 'OSPF must fail over to BACKUP with metric 101');
  assert.deepEqual(trace(payment, false, false), { loop: false, hops: primaryPath }, 'Healthy payment path is wrong');
  assert.deepEqual(trace(status, false, false), { loop: false, hops: primaryPath }, 'Healthy status path is wrong');
  assert.deepEqual(trace(status, true, false), { loop: false, hops: backupPath }, 'Status must survive the outage');
  assert.deepEqual(trace(payment, true, false), { loop: true, hops: [source, endpoints.PRIMARY, source] }, 'Payment must loop after the remote link failure');
  assert.deepEqual(trace(payment, true, true), { loop: false, hops: backupPath }, 'Removing the stale host route must restore payment over BACKUP');
}

function main() {
  insist(Number(process.versions.node.split('.')[0]) >= 22, 'Node.js 22 or newer is required');
  insist(process.argv.length <= 3 && (!process.argv[2] || process.argv[2] === '--check'), 'Usage: node scripts/build-lab.js [--check]');
  const { snapshot } = build();
  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
  if (process.argv[2] === '--check') {
    insist(fs.existsSync(output), 'Missing lab export. Run npm run build first.');
    assert.equal(fs.readFileSync(output, 'utf8'), serialized, 'Lab export is stale. Run npm run build and commit the updated JSON.');
    console.log('Checked: addresses, gateways, OSPF settings, cables, modeled route behavior, clean state, and reproducible export.');
  } else {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, serialized);
    console.log(`Built lab-files/green-status-red-checkout.json (${snapshot.doc.devices.length} devices, ${snapshot.doc.links.length} links).`);
  }
}

module.exports = { build, validate, parseRouter };
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
