import os from 'node:os';

export function lanAddresses(port) {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, url: `http://${ni.address}:${port}` });
    }
  }
  return out;
}
