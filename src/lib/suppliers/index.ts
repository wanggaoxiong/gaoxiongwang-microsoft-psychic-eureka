import { gxhyappConnector } from './gxhyapp/connector';
import { ninetyIiConnector } from './ninetyii/connector';
import type { SupplierConnector } from './base';

const connectors = new Map<string, SupplierConnector>([
  [gxhyappConnector.key, gxhyappConnector],
  [ninetyIiConnector.key, ninetyIiConnector]
]);

export function getSupplierConnector(key: string): SupplierConnector {
  const connector = connectors.get(key);

  if (!connector) {
    throw new Error(`Unsupported supplier connector: ${key}`);
  }

  return connector;
}

export function listSupplierConnectors() {
  return [...connectors.values()].map(({ key }) => ({
    key,
    name: key === 'gxhyapp' ? '共享货源 gxhyapp' : key === '90ii' ? '90ii 全球货源' : key
  }));
}
