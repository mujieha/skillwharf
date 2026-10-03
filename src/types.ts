export type AgentId = "claude" | "codex" | "agents" | "cursor";

export interface AgentOverride {
  projectPath?: string;
  globalPath?: string;
}

export interface SkillSpec {
  source: string;
  agents?: AgentId[];
}

export interface Manifest {
  version: 1;
  agents: AgentId[];
  agentPaths?: Partial<Record<AgentId, AgentOverride>>;
  /** 0.1.x: one registry. Still read, as a registry named "registry". */
  registry?: string;
  /** Registries searched by `search` and `add <name>`, in order. Absent (with no `registry`) means the public one. */
  registries?: RegistrySpec[];
  skills: Record<string, SkillSpec>;
}

/** A registry a project or the global manifest lists: `location` is `default`, an https index URL, a git source, or a local path. */
export interface RegistrySpec {
  name: string;
  location: string;
}

export interface LockEntry {
  source: string;
  resolved: string;
  integrity: string;
  version?: string;
  installedAt: string;
  /**
   * Agents whose folder holds a copy skillwharf made (the fallback when a
   * symlink is not permitted), keyed by agent. A real folder in an agent
   * directory counts as skillwharf's own only when the lock says so here.
   */
  links?: Partial<Record<AgentId, "copy">>;
}

export interface Lockfile {
  version: 1;
  skills: Record<string, LockEntry>;
}

export interface SkillMeta {
  name: string;
  description: string;
  version?: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export interface RegistryEntry {
  name: string;
  description: string;
  source: string;
  tags?: string[];
  version?: string;
}

export interface RegistryIndex {
  version: 1;
  skills: RegistryEntry[];
}

/** One registry after an attempt to load it: its index, or why it could not be loaded. */
export interface LoadedRegistry {
  name: string;
  location: string;
  /** Where the entry came from: the global manifest, the project manifest, or a `--registry` flag. */
  scope: "global" | "project" | "cli";
  index?: RegistryIndex;
  error?: string;
}

/** A search result: the entry, the registry it came from and its score. */
export interface SearchHit extends RegistryEntry {
  registry: string;
  score: number;
}

export interface Context {
  /** Project root (dir containing skillwharf.json) or home when --global */
  root: string;
  /** True when operating on ~/.skillwharf */
  global: boolean;
  home: string;
}
