// GATE-6, the address rule on its own (runtime-neutral, so every Gate adapter can rely on it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicAddress, isIpLiteral } from "../src/address.mjs";
import { assertFetchable } from "../src/resolver.mjs";

const NOT_PUBLIC = [
  "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200", "100.127.255.255", "127.0.0.1", "127.53.0.1",
  "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.8", "192.0.2.1", "192.88.99.1", "192.168.1.1", "198.18.0.1", "198.19.255.255",
  "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  "::", "::1", "::127.0.0.1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "::ffff:0:a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe",
  "64:ff9b:1::1", "2002:7f00:1::1", "2002:a9fe:a9fe::", "2001::1", "2001:db8::1", "3fff::1", "5f00::1", "fc00::1", "fd00:ec2::254", "fe80::1",
  "fe80::1%eth0", "[fe80::1]", "fec0::1", "ff02::1", "ff05::c", "100::1", "::ffff:10.0.0.1",
  "localhost", "example.com", "", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g", "1::2::3",
];
const PUBLIC = ["1.1.1.1", "8.8.8.8", "93.184.215.14", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.167.1.1", "198.20.0.1",
  "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2a00:1450:4001::1"];

test("GATE-6: isPublicAddress refuses every non-public range and IPv6 form of one, and accepts public unicast", () => {
  for (const a of NOT_PUBLIC) assert.equal(isPublicAddress(a), false, a);
  for (const a of PUBLIC) assert.equal(isPublicAddress(a), true, a);
  assert.equal(isIpLiteral("::ffff:127.0.0.1"), true);
  assert.equal(isIpLiteral("example.com"), false);
});

test("GATE-6: assertFetchable refuses non-public literals in every form the URL parser produces, local names and non-https", () => {
  const opts = {};
  const refused = ["https://127.1/", "https://2130706433/", "https://0x7f.1/", "https://0177.0.0.1/", "https://127.0.0.1./", "https://[::ffff:127.0.0.1]/",
    "https://[64:ff9b::a9fe:a9fe]/", "https://[2002:a9fe:a9fe::]/", "https://198.18.0.1/", "https://192.0.0.1/", "https://metadata/",
    "https://metadata.google.internal/", "https://localhost./", "https://a.localhost/", "https://printer.local/", "https://nas.lan/",
    "https://router.home.arpa/", "http://agent.example/", "https://user:pw@agent.example/"];
  for (const u of refused) assert.throws(() => assertFetchable(new URL(u), opts), undefined, u);
  for (const u of ["https://agent.example/", "https://1.1.1.1/", "https://[2606:4700:4700::1111]/"]) assert.doesNotThrow(() => assertFetchable(new URL(u), opts), u);
});
