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
  registry?: string;
  skills: Record<string, SkillSpec>;
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

export interface Context {
  /** Project root (dir containing skillwharf.json) or home when --global */
  root: string;
  /** True when operating on ~/.skillwharf */
  global: boolean;
  home: string;
}
