import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";

export function mergePluginCatalogItem(
  current: PluginListResult | null,
  plugin: PluginCatalogItem,
): PluginListResult | null {
  if (!current) {
    return current;
  }
  const existingIndex = current.plugins.findIndex((entry) => entry.id === plugin.id);
  const plugins = [...current.plugins];
  if (existingIndex >= 0) {
    plugins[existingIndex] = plugin;
  } else {
    plugins.push(plugin);
  }
  return { ...current, plugins };
}
