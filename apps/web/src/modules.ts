import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import type { LoadedModule, ModuleUiProps, RegistryError } from "@trellis/core";

export interface ClientModule extends LoadedModule {
  serverLoaded: boolean;
}
export interface ModulesResponse {
  modules: ClientModule[];
  errors: RegistryError[];
}

// Every .tsx under modules/ is a lazy chunk; a manifest's `ui` picks the entry.
const entries = import.meta.glob<{ default: ComponentType<ModuleUiProps> }>("../../../modules/*/**/*.tsx");
const cache = new Map<string, LazyExoticComponent<ComponentType<ModuleUiProps>>>();

export function moduleComponent(mod: LoadedModule) {
  if (!mod.manifest.ui) return null;
  const key = `../../../modules/${mod.dir}/${mod.manifest.ui}`;
  const load = entries[key];
  if (!load) return null;
  let comp = cache.get(key);
  if (!comp) cache.set(key, (comp = lazy(load)));
  return comp;
}
